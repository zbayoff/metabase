(ns metabase.query-processor.streaming-test
  (:require [cheshire.core :as json]
            [clojure.core.async :as a]
            [clojure.data.csv :as csv]
            [clojure.test :refer :all]
            [dk.ative.docjure.spreadsheet :as spreadsheet]
            [medley.core :as m]
            [metabase.async.streaming-response :as streaming-response]
            [metabase.models.card :refer [Card]]
            [metabase.models.field :refer [Field]]
            [metabase.models.table :refer [Table]]
            [metabase.models.card-test :as card-test]
            [metabase.query-processor :as qp]
            [metabase.query-processor.streaming :as qp.streaming]
            [metabase.test :as mt]
            [metabase.test.util :as tu]
            [toucan.db :as db]
            [metabase.util :as u])
  (:import [java.io BufferedInputStream BufferedOutputStream ByteArrayInputStream ByteArrayOutputStream InputStream InputStreamReader]
           javax.servlet.AsyncContext))

(defmulti ^:private parse-result
  {:arglists '([export-format ^InputStream input-stream])}
  (fn [export-format _] (keyword export-format)))

(defmethod parse-result :api
  [_ ^InputStream is]
  (with-open [reader (InputStreamReader. is)]
    (json/parse-stream reader true)))

(defmethod parse-result :json
  [export-format is]
  ((get-method parse-result :api) export-format is))

(defmethod parse-result :csv
  [_ ^InputStream is]
  (with-open [reader (InputStreamReader. is)]
    (doall (csv/read-csv reader))))

(defmethod parse-result :xlsx
  [_ ^InputStream is]
  (->> (spreadsheet/load-workbook-from-stream is)
       (spreadsheet/select-sheet "Query result")
       (spreadsheet/select-columns {:A "ID", :B "Name", :C "Category ID", :D "Latitude", :E "Longitude", :F "Price"})
       rest))

(defn- process-query-basic-streaming [export-format query]
  (with-open [bos (ByteArrayOutputStream.)
              os  (BufferedOutputStream. bos)]
    (qp/process-query query (assoc (qp.streaming/streaming-context export-format os)
                                   :timeout 15000))
    (.flush os)
    (let [bytea (.toByteArray bos)]
      (with-open [is (BufferedInputStream. (ByteArrayInputStream. bytea))]
        (parse-result export-format is)))))

(defn- process-query-api-response-streaming [export-format query]
  (with-open [bos (ByteArrayOutputStream.)
              os  (BufferedOutputStream. bos)]
    (mt/with-open-channels [canceled-chan (a/promise-chan)]
      (let [streaming-response (qp.streaming/streaming-response [context export-format]
                                 (qp/process-query-async query (assoc context :timeout 5000)))]
        (#'streaming-response/do-f-async (proxy [AsyncContext] []
                                           (complete []))
                                         (.f streaming-response)
                                         os
                                         (.donechan streaming-response)
                                         canceled-chan)
        (mt/wait-for-result (streaming-response/finished-chan streaming-response) 1000)))
    (let [bytea (.toByteArray bos)]
      (with-open [is (BufferedInputStream. (ByteArrayInputStream. bytea))]
        (parse-result export-format is)))))

(defmulti ^:private expected-results
  {:arglists '([export-format normal-results])}
  (fn [export-format _] (keyword export-format)))

(defmethod expected-results :api
  [_ normal-results]
  (tu/obj->json->obj normal-results))

(defmethod expected-results :json
  [_ normal-results]
  (let [{{:keys [cols rows]} :data} (tu/obj->json->obj normal-results)]
    (for [row rows]
      (zipmap (map (comp keyword :display_name) cols)
              row))))

(defmethod expected-results :csv
  [_ normal-results]
  (let [{{:keys [cols rows]} :data} normal-results]
    (cons (map :display_name cols)
          (for [row rows]
            (for [v row]
              (str v))))))

(defmethod expected-results :xlsx
  [_ normal-results]
  (let [{{:keys [cols rows]} :data} normal-results]
    (for [row rows]
      (zipmap (map :display_name cols)
              (for [v row]
                (if (number? v)
                  (double v)
                  v))))))

(defn- maybe-remove-checksum
  "remove metadata checksum if present because it can change between runs if encryption is in play"
  [x]
  (cond-> x
    (map? x) (m/dissoc-in [:data :results_metadata :checksum])))

(defn- expected-results* [export-format query]
  (maybe-remove-checksum (expected-results export-format (qp/process-query query))))

(defn- basic-actual-results* [export-format query]
  (maybe-remove-checksum (process-query-basic-streaming export-format query)))

(deftest basic-streaming-test []
  (testing "Test that the underlying qp.streaming context logic itself works correctly. Not an end-to-end test!"
    (let [query (mt/mbql-query venues
                  {:order-by [[:asc $id]]
                   :limit    5})]
      (doseq [export-format (qp.streaming/export-formats)]
        (testing export-format
          (is (= (expected-results* export-format query)
                 (basic-actual-results* export-format query))))))))

(defn- actual-results* [export-format query]
  (maybe-remove-checksum (process-query-api-response-streaming export-format query)))

(defn- compare-results [export-format query]
  (is (= (expected-results* export-format query)
         (actual-results* export-format query))))

(deftest streaming-response-test
  (testing "Test that the actual results going thru the same steps as an API response are correct."
    (doseq [export-format (qp.streaming/export-formats)]
      (testing export-format
        (compare-results export-format (mt/mbql-query venues {:limit 5}))))))

(deftest utf8-test
  ;; UTF-8 isn't currently working for XLSX -- fix me
  (doseq [export-format (disj (qp.streaming/export-formats) :xlsx)]
    (testing export-format
      (testing "Make sure our various streaming formats properly write values as UTF-8."
        (testing "A query that will have a little → in its name"
          (compare-results export-format (mt/mbql-query venues
                                           {:fields   [$name $category_id->categories.name]
                                            :order-by [[:asc $id]]
                                            :limit    5})))
        (testing "A query with emoji and other fancy unicode"
          (let [[sql & args] (db/honeysql->sql {:select [["Cam 𝌆 Saul 💩" :cam]]})]
            (compare-results export-format (mt/native-query {:query  sql
                                                             :params args}))))))))

(defn- make-col-settings [col-ref-to-settings]
  (let [cs (reduce-kv (fn [acc k v]
                        (assoc acc (json/generate-string k) v)) {} col-ref-to-settings)]
    {:column_settings cs}))

(deftest visualization-settings-in-export-test
  ;; TODO: expand to the other formats here
  (doseq [export-format [:csv]]
    (testing export-format
      (testing "A CSV export takes into account custom visualization settings"
        (let [tbl-id (db/select-one-id Table :name "CHECKINS")
              f1-id  (db/select-one-id Field :table_id tbl-id :name "ID")
              f2-id  (db/select-one-id Field :table_id tbl-id :name "DATE")
              cs-1   [:ref [:field f1-id nil]]
              cs-2   [:ref [:field f2-id nil]]
              cs-map {cs-1 {:column_title "Checkin ID"}
                      cs-2 {:date_style      "YYYY/M/D"
                            :date_abbreviate true
                            :time_enabled    nil
                            :time_style      nil}}]
          (mt/with-temp Card [card (card-test/card-with-source-table
                                    (mt/id :checkins)
                                    :visualization_settings
                                    (make-col-settings cs-map))]
            (let [card-id     (u/the-id card)
                  ds-query    (:dataset_query card)
                  inner-query (assoc (:query ds-query) :source-table (str "card__" card-id)
                                                       :limit 1
                                                       :order-by [[:asc [:field f1-id]]])
                  card-query  (assoc ds-query :query inner-query
                                              :middleware {:format-rows? false})]
              ;; the :column_title and the :date*/:time* viz settings should have been used to generate export
              (is (= [["Checkin ID" "Date" "User ID" "Venue ID"]
                      ["1" "2014/4/7" "5" "12"]]
                     (basic-actual-results* :csv card-query))))))))))
