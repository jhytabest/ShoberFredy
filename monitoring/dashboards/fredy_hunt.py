#!/usr/bin/env python3
import os

import theme
from grafana_foundation_sdk.builders import dashboard as dashboard_builder
from grafana_foundation_sdk.models.dashboard import DataSourceRef, DynamicConfigValue, VariableRefresh, VariableSort

UID = "fredy-hunt"
OUTPUT = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "grafana-dashboards",
    "fredy-hunt.json",
)

# Provisioned in homeserver's grafana-datasources.yml. A fixed uid, not
# discovered at build time, because this script has no way to ask a live
# Grafana what it decided to call the datasource — and Grafana's file
# provisioner is what enforces this exact string is what actually gets used.
SQLITE_UID = "fredy-sqlite"

# The primary price model. GBM exists too, but the hunt view answers "is this
# underpriced", not "which estimator" — that comparison is fredy-pipeline's.
MODEL_FAMILY = "ridge"

ACTIVE_SCORED = f"""
    FROM listings l
    JOIN homeserver_listing_model_scores s ON s.listing_id = l.id AND s.model_family = '{MODEL_FAMILY}'
    WHERE l.state = 'active' AND l.market = '$market'
"""

ACCEPTED_EXISTS = """
    EXISTS (SELECT 1 FROM listing_verdicts v WHERE v.listing_id = l.id AND v.verdict = 'accepted')
"""


def build():
    return (
        theme.page("Fredy Hunt", UID, ["fredy", "hunt"], refresh="5m", from_val="now-7d")
        .with_variable(
            dashboard_builder.QueryVariable("market")
            .label("Market")
            .datasource(DataSourceRef(type_val="frser-sqlite-datasource", uid=SQLITE_UID))
            .query("SELECT DISTINCT market AS __text, market AS __value FROM listings WHERE market IS NOT NULL ORDER BY market")
            .refresh(VariableRefresh.ON_TIME_RANGE_CHANGED)
            .sort(VariableSort.ALPHABETICAL_ASC)
        )
        .with_row(dashboard_builder.Row("Is there a flat"))
        .with_panel(
            theme.geomap()
            .title("Active listings, coloured by mispricing")
            .description(
                "Every active advert this market's job has accepted, positioned by geocode and coloured "
                "by how far below (blue) or above (red) the model's fair price it asks."
            )
            .span(24)
            .height(12)
            .targets(
                [
                    theme.sqlite(
                        SQLITE_UID,
                        f"""
                        SELECT l.latitude AS latitude, l.longitude AS longitude, l.title AS title,
                               l.price AS price, l.size AS size, s.delta_percent AS delta_percent,
                               ROUND(s.fair_price_per_sqm, 2) AS fair_eur_per_sqm, s.comps_500m AS comps_500m
                        {ACTIVE_SCORED}
                          AND l.latitude IS NOT NULL AND l.longitude IS NOT NULL AND {ACCEPTED_EXISTS}
                        """,
                    )
                ]
            )
            .layers([theme.marker_layer("listings", "delta_percent", min_value=-30, max_value=30)])
        )
        .with_panel(
            theme.sheet()
            .title("Best priced now")
            .description("Ranked by distance below the model's fair price. Titles link to the advert.")
            .span(24)
            .height(10)
            .targets(
                [
                    theme.sqlite(
                        SQLITE_UID,
                        f"""
                        SELECT l.title AS title, l.link AS link, l.provider AS provider,
                               l.price AS "rent EUR", l.size AS "m2",
                               ROUND(l.price / l.size, 2) AS "EUR/m2",
                               ROUND(s.fair_price_per_sqm, 2) AS "fair EUR/m2",
                               ROUND(s.delta_percent, 1) AS "delta %",
                               s.comps_500m AS comps,
                               datetime(l.created_at / 1000, 'unixepoch') AS "first seen"
                        {ACTIVE_SCORED}
                          AND {ACCEPTED_EXISTS}
                          AND l.created_at BETWEEN ${{__from}} AND ${{__to}}
                        ORDER BY s.delta_percent ASC
                        LIMIT 50
                        """,
                    )
                ]
            )
            .override_by_name(
                "title",
                [
                    DynamicConfigValue(
                        id_val="links",
                        value=[{"title": "Open advert", "url": "${__data.fields.link}", "targetBlank": True}],
                    )
                ],
            )
            .override_by_name("link", [DynamicConfigValue(id_val="custom.hidden", value=True)])
            .override_by_name(
                "delta %",
                [DynamicConfigValue(id_val="unit", value="percent"), DynamicConfigValue(id_val="decimals", value=1)],
            )
        )
        .with_row(dashboard_builder.Row("The market"))
        .with_panel(
            theme.trend()
            .title("Daily EUR per m2 (mean of active asks)")
            .description("The market's own asking-price trend, independent of the model.")
            .span(8)
            .unit("currencyEUR")
            .decimals(1)
            .targets(
                [
                    theme.sqlite(
                        SQLITE_UID,
                        """
                        SELECT date(l.created_at / 1000, 'unixepoch') AS time,
                               ROUND(AVG(l.price / l.size), 2) AS eur_per_sqm
                        FROM listings l
                        WHERE l.market = '$market' AND l.state = 'active' AND l.price > 0 AND l.size > 0
                          AND l.created_at BETWEEN ${__from} AND ${__to}
                        GROUP BY 1
                        ORDER BY 1
                        """,
                        format_val="time_series",
                    )
                ]
            )
            .transformations([{"id": "convertFieldType", "options": {"conversions": [{"destinationType": "time", "targetField": "time"}]}}])
        )
        .with_panel(
            theme.ranking()
            .title("Price heat by area")
            .description("Mean asking EUR/m2 in approximate 1 km coordinate cells, for currently active listings.")
            .span(8)
            .unit("currencyEUR")
            .thresholds(theme.flat(theme.palette_color(1)))
            .targets(
                [
                    theme.sqlite(
                        SQLITE_UID,
                        """
                        SELECT printf('%.2f, %.2f', ROUND(l.latitude, 2), ROUND(l.longitude, 2)) AS area,
                               ROUND(AVG(l.price / l.size), 2) AS eur_per_sqm
                        FROM listings l
                        WHERE l.market = '$market' AND l.state = 'active'
                          AND l.latitude IS NOT NULL AND l.longitude IS NOT NULL
                          AND l.price > 0 AND l.size > 0
                        GROUP BY ROUND(l.latitude, 2), ROUND(l.longitude, 2)
                        HAVING COUNT(*) >= 2
                        """,
                    )
                ]
            )
            .transformations([theme.sort_by("eur_per_sqm", desc=True)])
        )
        .with_panel(
            theme.ranking()
            .title("New arrivals today")
            .description("Which portal is actually producing for this market right now.")
            .span(8)
            .unit("short")
            .thresholds(theme.flat(theme.palette_color(0)))
            .targets(
                [
                    theme.sqlite(
                        SQLITE_UID,
                        """
                        SELECT l.provider AS provider, COUNT(*) AS new_listings
                        FROM listings l
                        WHERE l.market = '$market' AND l.created_at >= strftime('%s','now','start of day') * 1000
                        GROUP BY 1
                        """,
                    )
                ]
            )
            .transformations([theme.sort_by("new_listings", desc=True)])
        )
        .with_row(dashboard_builder.Row("What it costs to find this"))
        .with_panel(
            theme.metric_tile()
            .title("LLM calls per accepted listing")
            .description("Extraction cost, framed by what it bought: how many model calls each accepted advert took.")
            .span(4)
            .height(5)
            .unit("short")
            .decimals(1)
            .thresholds(theme.flat(theme.palette_color(1)))
            .targets(
                [
                    theme.sqlite(
                        SQLITE_UID,
                        f"""
                        SELECT CAST(
                          (SELECT COUNT(*) FROM llm_call_audit a
                           JOIN listings al ON al.id = a.listing_id
                           WHERE al.market = '$market'
                             AND a.started_at >= (strftime('%s','now') - 7*86400) * 1000)
                          AS REAL
                        ) / MAX(1, (
                          SELECT COUNT(DISTINCT l.id) FROM listings l
                          WHERE l.market = '$market' AND l.created_at >= (strftime('%s','now') - 7*86400) * 1000
                            AND {ACCEPTED_EXISTS}
                        )) AS calls_per_listing
                        """,
                    )
                ]
            )
        )
        .with_panel(
            theme.metric_tile()
            .title("LLM USD per accepted listing")
            .description("OpenRouter-reported cost over seven days, divided by accepted listings in this market.")
            .span(4)
            .height(5)
            .unit("currencyUSD")
            .decimals(3)
            .thresholds(theme.flat(theme.palette_color(1)))
            .targets(
                [
                    theme.sqlite(
                        SQLITE_UID,
                        f"""
                        SELECT COALESCE((
                          SELECT SUM(COALESCE(json_extract(a.usage_json, '$.cost'), 0))
                          FROM llm_call_audit a
                          JOIN listings al ON al.id = a.listing_id
                          WHERE al.market = '$market'
                            AND a.started_at >= (strftime('%s','now') - 7*86400) * 1000
                        ), 0) / MAX(1, (
                          SELECT COUNT(DISTINCT l.id) FROM listings l
                          WHERE l.market = '$market' AND l.created_at >= (strftime('%s','now') - 7*86400) * 1000
                            AND {ACCEPTED_EXISTS}
                        )) AS usd_per_listing
                        """,
                    )
                ]
            )
        )
        .with_panel(
            theme.metric_tile()
            .title("Median LLM latency")
            .description("From llm_call_audit.started_at/completed_at. Not cost, but the other half of what an extraction takes.")
            .span(4)
            .height(5)
            .unit("ms")
            .thresholds(theme.bad_above(8000, 20000))
            .targets(
                [
                    theme.sqlite(
                        SQLITE_UID,
                        """
                        WITH durations AS (
                          SELECT completed_at - started_at AS latency_ms,
                                 ROW_NUMBER() OVER (ORDER BY completed_at - started_at) AS position,
                                 COUNT(*) OVER () AS total
                          FROM llm_call_audit a
                          JOIN listings l ON l.id = a.listing_id
                          WHERE l.market = '$market' AND a.outcome = 'success' AND a.completed_at IS NOT NULL
                            AND a.started_at >= (strftime('%s','now') - 86400) * 1000
                        )
                        SELECT AVG(latency_ms) AS latency_ms
                        FROM durations
                        WHERE position IN ((total + 1) / 2, (total + 2) / 2)
                        """,
                    )
                ]
            )
        )
        .with_panel(
            theme.metric_tile()
            .title("LLM budget used today")
            .description("Requests spent of the daily budget, from llm_budget_usage — the ceiling, not the bill.")
            .span(4)
            .height(5)
            .unit("short")
            .thresholds(theme.flat(theme.palette_color(2)))
            .targets(
                [
                    theme.sqlite(
                        SQLITE_UID,
                        "SELECT COALESCE((SELECT count FROM llm_budget_usage WHERE day = strftime('%s','now','start of day') * 1000), 0) AS used",
                    )
                ]
            )
        )
        .with_panel(
            theme.metric_tile()
            .title("Geocode cache hit rate")
            .description("Share of cached addresses resolved on the first attempt, from homeserver_geocode_cache.")
            .span(4)
            .height(5)
            .unit("percentunit")
            .decimals(2)
            .thresholds(theme.good_above(0.7, 0.9))
            .targets(
                [
                    theme.sqlite(
                        SQLITE_UID,
                        """
                        SELECT CAST(SUM(CASE WHEN status = 'ok' AND attempts = 1 THEN 1 ELSE 0 END) AS REAL)
                               / MAX(1, COUNT(*)) AS hit_rate
                        FROM homeserver_geocode_cache
                        """,
                    )
                ]
            )
        )
        .with_panel(
            theme.metric_tile()
            .title("Accepted listings, 7d")
            .description("The denominator behind the cost row for the selected market.")
            .span(4)
            .height(5)
            .unit("short")
            .thresholds(theme.flat(theme.palette_color(3)))
            .targets(
                [
                    theme.sqlite(
                        SQLITE_UID,
                        f"""
                        SELECT COUNT(DISTINCT l.id) AS accepted
                        FROM listings l
                        WHERE l.market = '$market'
                          AND l.created_at >= (strftime('%s','now') - 7*86400) * 1000
                          AND {ACCEPTED_EXISTS}
                        """,
                    )
                ]
            )
        )
    )


theme.main(build, UID, OUTPUT, allowed_datasource_uids={SQLITE_UID})
