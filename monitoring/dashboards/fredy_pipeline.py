#!/usr/bin/env python3
import os

import theme
from grafana_foundation_sdk.builders import dashboard as dashboard_builder
from grafana_foundation_sdk.models.dashboard import VariableRefresh, VariableSort

UID = "fredy-pipeline"
OUTPUT = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "grafana-dashboards",
    "fredy-pipeline.json",
)

# Metrics that carry a market label and must be filtered by $market wherever
# they're queried on this dashboard — assert_sane's variable-consistency
# check fails the build if a panel forgets. fredy_market_model_interval used
# to be queried without it in two panels; declaring it here is what stops
# that regressing silently again.
MARKET_SCOPED_METRICS = {
    "fredy_market_model_error_percent",
    "fredy_market_model_interval",
    "fredy_market_prediction_model_created_timestamp_seconds",
    "fredy_market_delta_distribution",
}
METRIC_NAMES_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "metric-names.txt")
with open(METRIC_NAMES_PATH, encoding="utf-8") as metric_names_file:
    ALLOWED_METRIC_NAMES = {line.strip() for line in metric_names_file if line.strip() and not line.startswith("#")}


def build():
    return (
        theme.page("Fredy Pipeline", UID, ["fredy", "pipeline"], refresh="1m", from_val="now-7d")
        .with_variable(dashboard_builder.CustomVariable("model").values("gbm,ridge").label("Model"))
        # Markets come from the data, not from a list here: a city is added
        # by creating a job, and the dashboard should follow without an edit.
        .with_variable(
            dashboard_builder.QueryVariable("market")
            .label("Market")
            .datasource(theme.DATASOURCE)
            .query("label_values(fredy_market_prediction_model_created_timestamp_seconds, market)")
            .refresh(VariableRefresh.ON_TIME_RANGE_CHANGED)
            .sort(VariableSort.ALPHABETICAL_ASC)
        )
        # ---------------------------------------------------------------- pipeline
        .with_row(dashboard_builder.Row("Pipeline (all markets)"))
        .with_panel(
            theme.plain_tile()
            .title("Inventory (all markets)")
            .description("Global inventory metrics carry no market label, so this panel is explicitly independent of the market selector.")
            .span(24)
            .unit("short")
            .thresholds(theme.flat())
            .targets(
                [
                    theme.query('fredy_market_cleaned_listings{scope="active_visible"}', "Active on market", True, "A"),
                    theme.query('fredy_market_new_listings{window="1d"}', "New 24h", True, "B"),
                    theme.query('fredy_market_new_listings{window="7d"}', "New 7d", True, "C"),
                    theme.query('fredy_market_price_cuts{window="7d"}', "Price cuts 7d", True, "D"),
                    theme.query('fredy_market_cleaned_listings{scope="all_training"}', "Trainable", True, "E"),
                ]
            )
        )
        .with_panel(
            theme.ranking()
            .title("Discovery funnel")
            .description(
                "Cumulative totals, across every job and market. Everything shed at the card stage is "
                "free; everything refused after extraction has already cost an LLM call."
            )
            .span(8)
            .unit("short")
            .thresholds(theme.flat(theme.palette_color(0)))
            .targets(
                [
                    theme.query('fredy_pipeline_funnel{stage="sources"}', "Sources discovered", True, "A"),
                    theme.query('fredy_pipeline_funnel{stage="card_rejected"}', "Shed at card stage", True, "B"),
                    theme.query('fredy_pipeline_funnel{stage="listings"}', "Listings", True, "C"),
                    theme.query('fredy_pipeline_funnel{stage="llm_extracted"}', "LLM extractions", True, "D"),
                    theme.query('fredy_pipeline_funnel{stage="accepted"}', "Accepted", True, "E"),
                ]
            )
            .transformations([theme.sort_by("Value", desc=True)])
        )
        .with_panel(
            theme.ranking()
            .title("Refusals by reason")
            .description("Across both source refusals and listing verdicts. 'area' and 'intent' dominate.")
            .span(8)
            .unit("short")
            .thresholds(theme.flat(theme.palette_color(3)))
            .targets([theme.query("sort_desc(sum by (reason) (fredy_rejections))", "{{reason}}", True)])
            .transformations([theme.sort_by("Value", desc=True)])
        )
        .with_panel(
            theme.ranking()
            .title("Refusals by term")
            .description(
                "Which configured blacklist term, intent rule or specification field actually fired. This "
                "is how an over-broad term becomes visible instead of hiding inside one total."
            )
            .span(8)
            .unit("short")
            .thresholds(theme.flat(theme.palette_color(1)))
            .no_value("no term-level refusals recorded yet")
            .targets(
                [
                    theme.query(
                        "sort_desc(topk(12, sum by (reason_term) (fredy_rejections_by_term)))",
                        "{{reason_term}}",
                        True,
                    )
                ]
            )
            .transformations([theme.sort_by("Value", desc=True)])
        )
        .with_panel(
            theme.trend()
            .title("Card filter over-refusal rate")
            .description(
                "Of the card refusals that were sampled and then extracted anyway, the share the "
                "extraction disagreed with. A term refusing flats nobody asked it to shows up here."
            )
            .span(12)
            .unit("percentunit")
            .min(0)
            .max(1)
            .no_value("no card refusal has been contradicted by extraction")
            .targets(
                [
                    theme.query(
                        'sum by (reason) (fredy_card_filter_audit_total{verdict="card_wrong"})'
                        " / sum by (reason) (fredy_card_filter_audit_total)",
                        "{{reason}}",
                    )
                ]
            )
        )
        .with_panel(
            theme.trend()
            .title("LLM failures by outcome")
            .description("Successes are excluded on purpose; their volume would flatten everything else.")
            .span(12)
            .unit("short")
            .targets([theme.query('sum by (outcome) (fredy_llm_calls{outcome!="success"})', "{{outcome}}")])
        )
        # ------------------------------------------------------------ market model
        .with_row(dashboard_builder.Row("Market model"))
        .with_panel(
            theme.metric_tile()
            .title("Median error")
            .description("Out-of-fold MdAPE. Above 18% the model is not decision-grade.")
            .span(4)
            .height(5)
            .unit("percent")
            .decimals(1)
            .thresholds(theme.bad_above(18, 25))
            .targets(
                [
                    theme.query(
                        'fredy_market_model_error_percent{model="$model",market="$market",method="cv",stat="mdape"}',
                        instant=True,
                    )
                ]
            )
        )
        .with_panel(
            theme.metric_tile()
            .title("Skill vs naive")
            .description(
                "How much better than predicting the global median EUR/m2. The number that says whether "
                "the model earns its keep."
            )
            .span(4)
            .height(5)
            .unit("percent")
            .decimals(0)
            .thresholds(theme.good_above(20, 35))
            .targets(
                [
                    theme.query(
                        '100 * (1 - fredy_market_model_error_percent{model="$model",market="$market",method="cv",stat="mdape"}'
                        ' / on (model, market) fredy_market_model_error_percent{model="$model",market="$market",method="naive",stat="mdape"})',
                        instant=True,
                    )
                ]
            )
        )
        .with_panel(
            theme.metric_tile()
            .title("Within 10%")
            .description("Share of out-of-fold predictions inside 10% of the actual ask.")
            .span(4)
            .height(5)
            .unit("percent")
            .decimals(0)
            .thresholds(theme.good_above(30, 45))
            .targets(
                [
                    theme.query(
                        'fredy_market_model_error_percent{model="$model",market="$market",method="cv",stat="ppe10"}',
                        instant=True,
                    )
                ]
            )
        )
        .with_panel(
            theme.metric_tile()
            .title("Interval width")
            .description(
                "Median width of the 80% interval as a share of the prediction. Near 100% means a "
                "fair-price range of roughly plus or minus half, which cannot support a decision."
            )
            .span(4)
            .height(5)
            .unit("percent")
            .decimals(0)
            .thresholds(theme.bad_above(60, 90))
            .targets(
                [
                    theme.query(
                        'fredy_market_model_interval{model="$model",market="$market",stat="width_percent"}',
                        instant=True,
                    )
                ]
            )
        )
        .with_panel(
            theme.metric_tile()
            .title("Coverage error")
            .description("Signed distance from the conformal target. Green only when the interval is honest.")
            .span(4)
            .height(5)
            .unit("percent")
            .decimals(1)
            .thresholds(theme.symmetric(3, 8))
            .targets(
                [
                    theme.query(
                        '100 * (fredy_market_model_interval{model="$model",market="$market",stat="coverage"}'
                        ' - ignoring(stat) fredy_market_model_interval{model="$model",market="$market",stat="level"})',
                        instant=True,
                    )
                ]
            )
        )
        .with_panel(
            theme.metric_tile()
            .title("Model age")
            .description("Time since the artifact was trained. Red past 30h means a retrain has been failing.")
            .span(4)
            .height(5)
            .unit("s")
            .thresholds(theme.bad_above(97200, 108000))
            .targets(
                [
                    theme.query(
                        'time() - fredy_market_prediction_model_created_timestamp_seconds{model="$model",market="$market"}',
                        instant=True,
                    )
                ]
            )
        )
        .with_panel(
            theme.trend()
            .title("Error over time")
            .description("Out-of-fold error against the naive baseline, per retrain.")
            .span(12)
            .unit("percent")
            .targets(
                [
                    theme.query(
                        'fredy_market_model_error_percent{model="$model",market="$market",stat="mdape"}',
                        "{{method}}",
                    )
                ]
            )
        )
        .with_panel(
            theme.ranking()
            .title("Mispricing distribution")
            .description(
                "How far asks sit from the model's fair price. A wide spread here is the model's "
                "uncertainty, not a market signal. Ordered by price bucket, not alphabetically by label."
            )
            .span(12)
            .unit("short")
            .thresholds(theme.flat(theme.palette_color(2)))
            .targets([theme.query('fredy_market_delta_distribution{model="$model",market="$market"}', "{{bucket}}", True)])
            .transformations([theme.sort_by("order")])
        )
    )


theme.main(
    build,
    UID,
    OUTPUT,
    allowed_metric_names=ALLOWED_METRIC_NAMES,
    variable_scoped_metrics={"market": MARKET_SCOPED_METRICS},
)
