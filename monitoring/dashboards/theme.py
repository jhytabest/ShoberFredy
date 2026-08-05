from grafana_foundation_sdk.builders import bargauge, common, dashboard, stat, table, timeseries
from grafana_foundation_sdk.cog.encoder import JSONEncoder
from grafana_foundation_sdk.models.common import (
    GraphDrawStyle,
    GraphGradientMode,
    LegendDisplayMode,
    LegendPlacement,
    LineInterpolation,
    SortOrder,
    TooltipDisplayMode,
    VisibilityMode,
)
from grafana_foundation_sdk.models.dashboard import (
    DashboardCursorSync,
    DataSourceRef,
    DynamicConfigValue,
    MatcherConfig,
    Threshold,
    ThresholdsConfig,
    ThresholdsMode,
    ValueMap,
)
from grafana_foundation_sdk.builders.prometheus import Dataquery

DATASOURCE_UID = "PBFA97CFB590B2093"
DATASOURCE = DataSourceRef(type_val="prometheus", uid=DATASOURCE_UID)

ALLOWED_SPANS = {4, 6, 8, 12, 24}

GREEN = "green"
YELLOW = "yellow"
RED = "red"
NEUTRAL = "text"


def query(expr, legend="", instant=False, ref_id="A", fmt=None):
    q = Dataquery().expr(expr).ref_id(ref_id)
    if legend:
        q = q.legend_format(legend)
    if instant:
        q = q.instant()
    else:
        q = q.range()
    if fmt is not None:
        q = q.format(fmt)
    return q


def _thresholds(steps):
    return (
        dashboard.ThresholdsConfig()
        .mode(ThresholdsMode.ABSOLUTE)
        .steps([Threshold(value=v, color=c) for v, c in steps])
    )


def bad_above(warn, crit):
    return _thresholds([(None, GREEN), (warn, YELLOW), (crit, RED)])


def good_above(warn, good):
    return _thresholds([(None, RED), (warn, YELLOW), (good, GREEN)])


def symmetric(warn, crit):
    return _thresholds([(None, RED), (-crit, YELLOW), (-warn, GREEN), (warn, YELLOW), (crit, RED)])


def flat(color=NEUTRAL):
    return _thresholds([(None, color)])


def boolean():
    return _thresholds([(None, RED), (1, GREEN)])


BOOLEAN_MAP = [ValueMap(options={"0": {"text": "FAIL", "color": RED}, "1": {"text": "OK", "color": GREEN}})]


def _tile(color_mode, graph_mode):
    return (
        stat.Panel()
        .datasource(DATASOURCE)
        .height(4)
        .color_mode(color_mode)
        .graph_mode(graph_mode)
        .justify_mode("center")
        .text_mode("value_and_name")
        .reduce_options(common.ReduceDataOptions().calcs(["lastNotNull"]).values(False))
    )


def alarm_tile():
    return _tile("background", "none")


def metric_tile():
    return _tile("value", "area")


def plain_tile():
    return _tile("none", "none")


def trend():
    return (
        timeseries.Panel()
        .datasource(DATASOURCE)
        .height(8)
        .draw_style(GraphDrawStyle.LINE)
        .line_width(2)
        .fill_opacity(12)
        .line_interpolation(LineInterpolation.SMOOTH)
        .show_points(VisibilityMode.NEVER)
        .gradient_mode(GraphGradientMode.OPACITY)
        .span_nulls(False)
        .axis_border_show(False)
        .legend(
            common.VizLegendOptions()
            .display_mode(LegendDisplayMode.LIST)
            .placement(LegendPlacement.BOTTOM)
            .show_legend(True)
        )
        .tooltip(common.VizTooltipOptions().mode(TooltipDisplayMode.MULTI).sort(SortOrder.DESCENDING))
    )


def ranking():
    return (
        bargauge.Panel()
        .datasource(DATASOURCE)
        .height(8)
        .orientation("horizontal")
        .display_mode("gradient")
        .show_unfilled(True)
        .reduce_options(common.ReduceDataOptions().calcs(["lastNotNull"]).values(False))
    )


def sheet():
    return table.Panel().datasource(DATASOURCE).height(9).show_header(True).cell_height("sm")


def color_text():
    return DynamicConfigValue(id_val="custom.cellOptions", value={"type": "color-text"})


def matcher(name):
    return MatcherConfig(id_val="byName", options=name)


def page(title, uid, tags, refresh="1m", from_val="now-24h"):
    return (
        dashboard.Dashboard(title)
        .uid(uid)
        .tags(list(tags) + ["generated"])
        .timezone("browser")
        .tooltip(DashboardCursorSync.CROSSHAIR)
        .refresh(refresh)
        .time(from_val, "now")
        .editable()
    )


def render(builder):
    return JSONEncoder(sort_keys=True, indent=2).encode(builder.build()) + "\n"


def assert_sane(built, expected_uid):
    if built.uid != expected_uid:
        raise SystemExit(f"uid mismatch: {built.uid} != {expected_uid}")
    titles = []
    for panel in built.panels or []:
        if getattr(panel, "type_val", None) == "row":
            continue
        if not panel.title:
            raise SystemExit("a panel has no title")
        if not panel.targets:
            raise SystemExit(f"panel {panel.title!r} has no targets")
        for target in panel.targets:
            ds = getattr(target, "datasource", None) or getattr(panel, "datasource", None)
            uid = getattr(ds, "uid", None) if ds else None
            if uid != DATASOURCE_UID:
                raise SystemExit(f"panel {panel.title!r} target is not on the Prometheus datasource")
        span = panel.grid_pos.w if panel.grid_pos else None
        if span not in ALLOWED_SPANS:
            raise SystemExit(f"panel {panel.title!r} has span {span}, not one of {sorted(ALLOWED_SPANS)}")
        titles.append(panel.title)
    duplicates = {t for t in titles if titles.count(t) > 1}
    if duplicates:
        raise SystemExit(f"duplicate panel titles: {sorted(duplicates)}")
    return len(titles)


def main(build_dashboard, uid, output_path):
    import sys

    built = build_dashboard()
    panels = assert_sane(built.build(), uid)
    rendered = render(built)
    if "--check" in sys.argv[1:]:
        try:
            current = open(output_path, encoding="utf-8").read()
        except FileNotFoundError:
            raise SystemExit(f"{output_path} is missing; run this script without --check")
        if current != rendered:
            import difflib

            diff = difflib.unified_diff(
                current.splitlines(keepends=True),
                rendered.splitlines(keepends=True),
                fromfile=f"{output_path} (committed)",
                tofile=f"{output_path} (generated)",
            )
            sys.stdout.writelines(diff)
            raise SystemExit(f"{output_path} does not match its generator")
        print(f"{output_path} matches its generator ({panels} panels)")
        return
    open(output_path, "w", encoding="utf-8").write(rendered)
    print(f"wrote {output_path} ({panels} panels)")
