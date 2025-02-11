import {
  restore,
  popover,
  createNativeQuestion,
  openOrdersTable,
  remapDisplayValueToFK,
  sidebar,
} from "__support__/cypress";

import { SAMPLE_DATASET } from "__support__/cypress_sample_dataset";

const { ORDERS, ORDERS_ID, PRODUCTS, PRODUCTS_ID } = SAMPLE_DATASET;

describe("scenarios > question > nested (metabase#12568)", () => {
  beforeEach(() => {
    restore();
    cy.signInAsAdmin();

    // Create a simple question of orders by week
    cy.createQuestion({
      name: "GH_12568: Simple",
      query: {
        "source-table": ORDERS_ID,
        aggregation: [["count"]],
        breakout: [["field", ORDERS.CREATED_AT, { "temporal-unit": "week" }]],
      },
      display: "line",
    });

    // Create a native question of orders by day
    cy.createNativeQuestion({
      name: "GH_12568: SQL",
      native: {
        query:
          "SELECT date_trunc('day', CREATED_AT) as date, COUNT(*) as count FROM ORDERS GROUP BY date_trunc('day', CREATED_AT)",
      },
      display: "scalar",
    });

    // Create a complex native question
    cy.createNativeQuestion({
      name: "GH_12568: Complex SQL",
      native: {
        query: `WITH tmp_user_order_dates as (
            SELECT
              o.USER_ID,
              o.CREATED_AT,
              o.QUANTITY
            FROM
              ORDERS o
          ),

          tmp_prior_orders_by_date as (
            select
                tbod.USER_ID,
                tbod.CREATED_AT,
                tbod.QUANTITY,
                (select count(*) from tmp_user_order_dates tbod2 where tbod2.USER_ID = tbod.USER_ID and tbod2.CREATED_AT < tbod.CREATED_AT ) as PRIOR_ORDERS
            from tmp_user_order_dates tbod
          )

          select
            date_trunc('day', tpobd.CREATED_AT) as "Date",
            case when tpobd.PRIOR_ORDERS > 0 then 'Return' else 'New' end as "Customer Type",
            sum(QUANTITY) as "Items Sold"
          from tmp_prior_orders_by_date tpobd
          group by date_trunc('day', tpobd.CREATED_AT), "Customer Type"
          order by date_trunc('day', tpobd.CREATED_AT) asc`,
      },
      display: "scalar",
    });
  });

  it("should allow Distribution on a Saved Simple Question", () => {
    cy.visit("/question/new");
    cy.contains("Simple question").click();
    cy.contains("Saved Questions").click();
    cy.contains("GH_12568: Simple").click();
    cy.contains("Count").click();
    cy.contains("Distribution").click();
    cy.contains("Count by Count: Auto binned");
    cy.get(".bar").should("have.length.of.at.least", 10);
  });

  it("should allow Sum over time on a Saved Simple Question", () => {
    cy.visit("/question/new");
    cy.contains("Simple question").click();
    cy.contains("Saved Questions").click();
    cy.contains("GH_12568: Simple").click();
    cy.contains("Count").click();
    cy.contains("Sum over time").click();
    cy.contains("Sum of Count");
    cy.get(".dot").should("have.length.of.at.least", 10);
  });

  it("should allow Distribution on a Saved SQL Question", () => {
    cy.visit("/question/new");
    cy.contains("Simple question").click();
    cy.contains("Saved Questions").click();
    cy.contains("GH_12568: SQL").click();
    cy.contains("COUNT").click();
    cy.contains("Distribution").click();
    cy.contains("Count by COUNT: Auto binned");
    cy.get(".bar").should("have.length.of.at.least", 10);
  });

  it("should allow Sum over time on a Saved SQL Question", () => {
    cy.visit("/question/new");
    cy.contains("Simple question").click();
    cy.contains("Saved Questions").click();
    cy.contains("GH_12568: SQL").click();
    cy.contains("COUNT").click();
    cy.contains("Sum over time").click();
    cy.contains("Sum of COUNT");
    cy.get(".dot").should("have.length.of.at.least", 10);
  });

  it("should allow Distribution on a Saved complex SQL Question", () => {
    cy.visit("/question/new");
    cy.contains("Simple question").click();
    cy.contains("Saved Questions").click();
    cy.contains("GH_12568: Complex SQL").click();
    cy.contains("Items Sold").click();
    cy.contains("Distribution").click();
    cy.contains("Count by Items Sold: Auto binned");
    cy.get(".bar").should("have.length.of.at.least", 10);
  });
});

describe("scenarios > question > nested", () => {
  beforeEach(() => {
    restore();
    cy.signInAsAdmin();
  });

  it("should handle duplicate column names in nested queries (metabase#10511)", () => {
    cy.createQuestion({
      name: "10511",
      query: {
        filter: [">", ["field", "count", { "base-type": "type/Integer" }], 5],
        "source-query": {
          "source-table": ORDERS_ID,
          aggregation: [["count"]],
          breakout: [
            ["field", ORDERS.CREATED_AT, { "temporal-unit": "month" }],
            [
              "field",
              PRODUCTS.CREATED_AT,
              { "temporal-unit": "month", "source-field": ORDERS.PRODUCT_ID },
            ],
          ],
        },
      },
    }).then(({ body: { id: questionId } }) => {
      cy.visit(`/question/${questionId}`);
      cy.findByText("10511");
      cy.findAllByText("June, 2016");
      cy.findAllByText("13");
    });
  });

  it.skip("should display granularity for aggregated fields in nested questions (metabase#13764)", () => {
    openOrdersTable({ mode: "notebook" });
    // add initial aggregation ("Average of Total by Order ID")
    cy.findByText("Summarize").click();
    cy.findByText("Average of ...").click();
    cy.findByText("Total").click();
    cy.findByText("Pick a column to group by").click();
    cy.findByText("ID").click();
    // add another aggregation ("Count by Average of Total")
    cy.get(".Button")
      .contains("Summarize")
      .click();
    cy.findByText("Count of rows").click();
    cy.findByText("Pick a column to group by").click();
    cy.log("Reported failing on v0.34.3 - v0.37.0.2");
    popover()
      .contains("Average of Total")
      .closest(".List-item")
      .contains("Auto binned");
  });

  it.skip("should show all filter options for a nested question (metabase#13186)", () => {
    cy.log("Create and save native question Q1");

    createNativeQuestion("13816_Q1", "SELECT * FROM PRODUCTS").then(
      ({ body: { id: Q1_ID } }) => {
        cy.log("Convert it to `query` and save as Q2");
        cy.createQuestion({
          name: "13816_Q2",
          query: {
            "source-table": `card__${Q1_ID}`,
          },
        });
      },
    );

    cy.createDashboard("13186D").then(({ body: { id: DASBOARD_ID } }) => {
      cy.visit(`/dashboard/${DASBOARD_ID}`);
    });

    // Add Q2 to that dashboard
    cy.icon("pencil").click();
    cy.icon("add")
      .last()
      .click();
    cy.findByText("13816_Q2").click();

    // Add filter to the dashboard...
    cy.icon("filter").click();
    cy.findByText("Other Categories").click();
    // ...and try to connect it to the question
    cy.findByText("Select…").click();

    cy.log("Reported failing in v0.36.4 (`Category` is missing)");
    popover().within(() => {
      cy.findByText(/Category/i);
      cy.findByText(/Title/i);
      cy.findByText(/Vendor/i);
    });
  });

  it.skip("should apply metrics including filter to the nested question (metabase#12507)", () => {
    const METRIC_NAME = "Discount Applied";

    cy.log("Create a metric with a filter");

    cy.request("POST", "/api/metric", {
      name: METRIC_NAME,
      description: "Discounted orders.",
      definition: {
        aggregation: [["count"]],
        filter: ["not-null", ["field", ORDERS.DISCOUNT, null]],
        "source-table": ORDERS_ID,
      },
      table_id: ORDERS_ID,
    }).then(({ body: { id: METRIC_ID } }) => {
      // "capture" the original query because we will need to re-use it later in a nested question as "source-query"
      const ORIGINAL_QUERY = {
        aggregation: ["metric", METRIC_ID],
        breakout: [
          ["field", ORDERS.TOTAL, { binning: { strategy: "default" } }],
        ],
        "source-table": ORDERS_ID,
      };

      // Create new question which uses previously defined metric
      cy.createQuestion({
        name: "Orders with discount applied",
        query: ORIGINAL_QUERY,
        display: "bar",
        visualization_settings: {
          "graph.dimension": ["TOTAL"],
          "graph.metrics": [METRIC_NAME],
        },
      }).then(({ body: { id: QUESTION_ID } }) => {
        cy.server();
        cy.route("POST", `/api/card/${QUESTION_ID}/query`).as("cardQuery");

        cy.log("Create a nested question based on the previous one");

        // we're adding filter and saving/overwriting the original question, keeping the same ID
        cy.request("PUT", `/api/card/${QUESTION_ID}`, {
          dataset_query: {
            database: 1,
            query: {
              filter: [
                ">",
                ["field", "TOTAL", { "base-type": "type/Float" }],
                50,
              ],
              "source-query": ORIGINAL_QUERY,
            },
            type: "query",
          },
        });

        cy.log("Reported failing since v0.35.2");
        cy.visit(`/question/${QUESTION_ID}`);
        cy.wait("@cardQuery").then(xhr => {
          expect(xhr.response.body.error).not.to.exist;
        });
        cy.findByText(METRIC_NAME);
        cy.get(".bar");
      });
    });
  });

  it("should handle remapped display values in a base QB question (metabase#10474)", () => {
    cy.log(
      "Related issue [#14629](https://github.com/metabase/metabase/issues/14629)",
    );

    cy.server();
    cy.route("POST", "/api/dataset").as("dataset");

    cy.log("Remap Product ID's display value to `title`");
    remapDisplayValueToFK({
      display_value: ORDERS.PRODUCT_ID,
      name: "Product ID",
      fk: PRODUCTS.TITLE,
    });

    cy.createQuestion({
      name: "Orders (remapped)",
      query: { "source-table": ORDERS_ID },
    });

    // Try to use saved question as a base for a new / nested question
    cy.visit("/question/new");
    cy.findByText("Simple question").click();
    cy.findByText("Saved Questions").click();
    cy.findByText("Orders (remapped)").click();

    cy.wait("@dataset").then(xhr => {
      expect(xhr.response.body.error).not.to.exist;
    });
    cy.findAllByText("Awesome Concrete Shoes");
  });

  ["remapped", "default"].forEach(test => {
    describe(`${test.toUpperCase()} version: question with joins as a base for new quesiton(s) (metabase#14724)`, () => {
      const QUESTION_NAME = "14724";
      const SECOND_QUESTION_NAME = "14724_2";

      beforeEach(() => {
        if (test === "remapped") {
          cy.log("Remap Product ID's display value to `title`");
          remapDisplayValueToFK({
            display_value: ORDERS.PRODUCT_ID,
            name: "Product ID",
            fk: PRODUCTS.TITLE,
          });
        }

        cy.server();
        cy.route("POST", "/api/dataset").as("dataset");
      });

      it("should handle single-level nesting", () => {
        ordersJoinProducts(QUESTION_NAME);

        // Start new question from a saved one
        cy.visit("/question/new");
        cy.findByText("Simple question").click();
        cy.findByText("Saved Questions").click();
        cy.findByText(QUESTION_NAME).click();

        cy.wait("@dataset").then(xhr => {
          expect(xhr.response.body.error).not.to.exist;
        });
        cy.contains("37.65");
      });

      it("should handle multi-level nesting", () => {
        // Use the original question qith joins, then save it again
        ordersJoinProducts(QUESTION_NAME).then(
          ({ body: { id: ORIGINAL_QUESTION_ID } }) => {
            cy.createQuestion({
              name: SECOND_QUESTION_NAME,
              query: { "source-table": `card__${ORIGINAL_QUESTION_ID}` },
            });
          },
        );

        // Start new question from already saved nested question
        cy.visit("/question/new");
        cy.findByText("Simple question").click();
        cy.findByText("Saved Questions").click();
        cy.findByText(SECOND_QUESTION_NAME).click();

        cy.wait("@dataset").then(xhr => {
          expect(xhr.response.body.error).not.to.exist;
        });
        cy.contains("37.65");
      });
    });
  });

  it.skip("'distribution' should work on a joined table from a saved question (metabase#14787)", () => {
    // Set the display really wide and really tall to avoid any scrolling
    cy.viewport(1600, 1200);

    ordersJoinProducts("14787");
    // This repro depends on these exact steps - it has to be opened from the saved questions
    cy.visit("/question/new");
    cy.findByText("Simple question").click();
    cy.findByText("Saved Questions").click();
    cy.findByText("14787").click();

    // The column title
    cy.findByText("Products → Category").click();
    cy.findByText("Distribution").click();
    cy.contains("Summarize").click();
    cy.findByText("Group by")
      .parent()
      .within(() => {
        cy.log("Regression that worked on 0.37.9");
        isSelected("Products → Category");
      });

    // Although the test will fail on the previous step, we're including additional safeguards against regressions once the issue is fixed
    // It can potentially fail at two more places. See [1] and [2]
    cy.icon("notebook").click();
    cy.get("[class*=NotebookCellItem]")
      .contains(/^Products → Category$/) /* [1] */
      .click();
    popover().within(() => {
      isSelected("Products → Category"); /* [2] */
    });

    /**
     * Helper function related to this test only
     * TODO:
     *  Extract it if we have the need for it anywhere else
     */
    function isSelected(text) {
      cy.findByText(text)
        .closest(".List-item")
        .should($el => {
          const className = $el[0].className;

          expect(className).to.contain("selected");
        });
    }
  });

  ["count", "average"].forEach(test => {
    it.skip(`${test.toUpperCase()}:\n should be able to use aggregation functions on saved native question (metabase#15397)`, () => {
      cy.server();
      cy.route("POST", "/api/dataset").as("dataset");

      cy.createNativeQuestion({
        name: "15397",
        native: {
          query:
            "select count(*), orders.product_id from orders group by orders.product_id;",
        },
      });
      cy.visit("/question/new");
      cy.findByText("Simple question").click();
      cy.findByText("Saved Questions").click();
      cy.findByText("15397").click();
      cy.wait("@dataset");
      cy.findAllByText("Summarize")
        .first()
        .click();
      if (test === "average") {
        sidebar()
          .findByText("Count")
          .should("be.visible")
          .click();
        cy.findByText("Average of ...").click();
        popover()
          .findByText("COUNT(*)")
          .click();
        cy.wait("@dataset");
      }
      cy.findByText("Group by")
        .parent()
        .findByText("COUNT(*)")
        .click();

      cy.wait("@dataset").then(xhr => {
        expect(xhr.response.body.error).not.to.exist;
      });
      cy.get(".bar").should("have.length.of.at.least", 20);
    });
  });

  describe.skip("should use the same query for date filter in both base and nested questions (metabase#15352)", () => {
    it("should work with 'between' date filter (metabase#15352-1)", () => {
      assertOnFilter({
        name: "15352-1",
        filter: [
          "between",
          ["field-id", ORDERS.CREATED_AT],
          "2020-02-01",
          "2020-02-29",
        ],
        value: "543",
      });
    });

    it("should work with 'after/before' date filter (metabase#15352-2)", () => {
      assertOnFilter({
        name: "15352-2",
        filter: [
          "and",
          [">", ["field-id", ORDERS.CREATED_AT], "2020-01-31"],
          ["<", ["field-id", ORDERS.CREATED_AT], "2020-03-01"],
        ],
        value: "543",
      });
    });

    it("should work with 'on' date filter (metabase#15352-3)", () => {
      assertOnFilter({
        name: "15352-3",
        filter: ["=", ["field-id", ORDERS.CREATED_AT], "2020-02-01"],
        value: "17",
      });
    });

    function assertOnFilter({ name, filter, value } = {}) {
      cy.createQuestion({
        name,
        query: {
          "source-table": ORDERS_ID,
          filter,
          aggregation: [["count"]],
        },
        type: "query",
        display: "scalar",
      }).then(({ body }) => {
        cy.visit(`/question/${body.id}`);
        cy.get(".ScalarValue").findByText(value);
      });
      // Start new question based on the saved one
      cy.visit("/question/new");
      cy.findByText("Simple question").click();
      cy.findByText("Saved Questions").click();
      cy.findByText(name).click();
      cy.get(".ScalarValue").findByText(value);
    }
  });
});

function ordersJoinProducts(name) {
  return cy.createQuestion({
    name,
    query: {
      "source-table": ORDERS_ID,
      joins: [
        {
          fields: "all",
          "source-table": PRODUCTS_ID,
          condition: [
            "=",
            ["field", ORDERS.PRODUCT_ID, null],
            ["field", PRODUCTS.ID, { "join-alias": "Products" }],
          ],
          alias: "Products",
        },
      ],
    },
  });
}
