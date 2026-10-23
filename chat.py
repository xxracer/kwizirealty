"""
chat.py — Hommie AI, the ResDogs assistant.

Port of `new kwizi`'s /api/chat: Gemini with function calling. The tools map
to the SAME UI actions the old app had (select areas, change boundary, metric,
filters, period) plus a live stats lookup against our SQL data.

The model is called through the REST API so no extra SDK is needed.
"""

import json
import urllib.error
import urllib.request

import engine
import firebase_data as fd
from metrics import BOUNDARY_BY_KEY, METRIC_BY_KEY

MODEL = fd._env("GEMINI_MODEL") or "gemini-flash-latest"
API_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={key}"

BOUNDARY_KEYS = ["subdivisions", "zipcodes", "highschools", "elementary", "middle", "neighborhoods", "areas"]
METRIC_KEYS = list(METRIC_BY_KEY.keys())
PERIOD_KEYS = ["r5y", "r3y", "r1y", "all", "30d", "90d", "6m", "ytd", "1y", "2y", "3y", "4y", "5y"]

TOOLS = [
    {
        "name": "select_map_areas",
        "description": "Select areas on the map and optionally generate the report.",
        "parameters": {
            "type": "object",
            "properties": {
                "areas": {"type": "array", "items": {"type": "string"},
                          "description": "Area names as the user said them (e.g. ['Katy', 'Sugar Land'])."},
                "generate_report": {"type": "boolean",
                                    "description": "True if the user also asked for a report/analysis."},
            },
            "required": ["areas"],
        },
    },
    {
        "name": "set_map_boundary",
        "description": "Change the geographic boundary layer on the map.",
        "parameters": {
            "type": "object",
            "properties": {"boundary": {"type": "string", "enum": BOUNDARY_KEYS}},
            "required": ["boundary"],
        },
    },
    {
        "name": "set_map_metric",
        "description": "Change the active market metric displayed on the map.",
        "parameters": {
            "type": "object",
            "properties": {"metric": {"type": "string", "enum": METRIC_KEYS}},
            "required": ["metric"],
        },
    },
    {
        "name": "set_map_period",
        "description": "Change the close period (time window) of the map.",
        "parameters": {
            "type": "object",
            "properties": {"period": {"type": "string", "enum": PERIOD_KEYS}},
            "required": ["period"],
        },
    },
    {
        "name": "set_map_filters",
        "description": "Apply property filters to the map (budget, beds, baths, sqft, year, pool).",
        "parameters": {
            "type": "object",
            "properties": {
                "filters": {
                    "type": "object",
                    "properties": {
                        "saleMin": {"type": "number"}, "saleMax": {"type": "number"},
                        "rentMin": {"type": "number"}, "rentMax": {"type": "number"},
                        "bedsMin": {"type": "number"}, "bedsMax": {"type": "number"},
                        "bathsMin": {"type": "number"}, "bathsMax": {"type": "number"},
                        "sqftMin": {"type": "number"}, "sqftMax": {"type": "number"},
                        "yearMin": {"type": "number"}, "yearMax": {"type": "number"},
                        "pool": {"type": "string", "enum": ["any", "yes", "no"]},
                    },
                },
            },
            "required": ["filters"],
        },
    },
    {
        "name": "get_area_stats",
        "description": "Look up live statistics for one or more areas in the current metric and period.",
        "parameters": {
            "type": "object",
            "properties": {"areas": {"type": "array", "items": {"type": "string"}}},
            "required": ["areas"],
        },
    },
    {
        "name": "ask_interactive_question",
        "description": "Ask a multiple-choice question; the UI renders buttons.",
        "parameters": {
            "type": "object",
            "properties": {
                "question": {"type": "string"},
                "options": {"type": "array", "items": {"type": "string"}},
                "multi_select": {"type": "boolean"},
            },
            "required": ["question", "options"],
        },
    },
]


def _system_prompt(context: dict) -> str:
    ctx = context or {}
    stats = ctx.get("stats") or {}
    health = ctx.get("health") or {}
    return f"""
You are Hommie, the friendly Houston real-estate assistant of ResDogs.
You answer ONLY with the internal data of this platform.

### Current UI context
- Boundary: {ctx.get('boundary') or 'subdivisions'}
- Metric: {ctx.get('metricLabel') or ctx.get('metric') or 'Sales Price'}
- Period: {ctx.get('periodLabel') or ctx.get('period') or 'Last 5 years'}
- Selected areas: {", ".join(ctx.get('selectedNames') or []) or 'none'}
- Rows in the selection: {stats.get('count') or 0}
- Average sale price: {stats.get('avgSale') or 'n/a'}
- Median rent: {stats.get('medianRent') or 'n/a'}
- Market health: {health.get('label') or 'n/a'} ({health.get('score') or 'n/a'})

### Rules
1. Use ONLY the data above and the tool results. Never invent numbers.
2. If the data is not available, say so plainly.
3. Reply in the same language the user writes in (Spanish or English).
4. When the user asks to see/filter properties (beds, baths, price, sqft, year, pool),
   call set_map_filters. A bare price like "under 500" means $500,000 for sales;
   rents are monthly (no x1000).
5. When the user asks to highlight/find areas or asks for a report, call
   select_map_areas with generate_report=true if they asked for a report.
6. Keep answers short (2-4 sentences) and concrete.
7. After a tool call, confirm in one sentence what you changed.
""".strip()


def _gemini(contents: list, tools: bool = True) -> dict:
    key = fd._env("GOOGLE_GENERATIVE_AI_API_KEY") or fd._env("GEMINI_API_KEY")
    if not key:
        raise RuntimeError("GOOGLE_GENERATIVE_AI_API_KEY is not configured")
    body = {
        "systemInstruction": {"parts": [{"text": _system_prompt(_CONTEXT.get("value") or {})}]},
        "contents": contents,
        "generationConfig": {"temperature": 0.3, "maxOutputTokens": 900},
    }
    if tools:
        body["tools"] = [{"functionDeclarations": TOOLS}]
    req = urllib.request.Request(
        API_URL.format(model=MODEL, key=key),
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", "replace")
        raise RuntimeError(f"Gemini HTTP {exc.code}: {raw[:300]}") from None


_CONTEXT = {"value": {}}


def _match_areas(boundary: str, terms: list[str], limit: int = 8) -> list[str]:
    try:
        features = engine.boundary_features(boundary)
    except Exception:  # noqa: BLE001
        return []
    names = []
    seen = set()
    for f in features:
        props = f.get("properties") or {}
        raw = props.get("name")
        if raw in (None, ""):
            for key in ("NAME", "Name", "Zip_Code", "Subdivision"):
                if props.get(key) not in (None, ""):
                    raw = props[key]
                    break
        name = fd.clean_boundary_name(raw)
        if name and name not in seen:
            seen.add(name)
            names.append(name)

    out = []
    for term in terms:
        t = fd.clean_boundary_name(term)
        if not t:
            continue
        for name in names:
            if t in name or name in t:
                if name not in out:
                    out.append(name)
                if len(out) >= limit:
                    return out
    return out


def _execute(name: str, args: dict, context: dict) -> tuple[dict, dict | None]:
    boundary = context.get("boundary") or "subdivisions"
    metric = context.get("metric") or "Close Price"
    period = context.get("period") or "r5y"
    filters = context.get("filters") or {}

    if name == "select_map_areas":
        terms = args.get("areas") or []
        matched = _match_areas(boundary, terms)
        stats = engine.area_stats(filters, period, matched or None, boundary) if matched else {}
        values = engine.aggregate_by_name(metric, boundary, filters, period) if matched else {}
        per = [
            {"name": m, "label": fd.expand_boundary_name(m),
             "value": (values.get(m) or {}).get("value"),
             "count": (values.get(m) or {}).get("count", 0)}
            for m in matched
        ]
        result = {"matched": matched, "stats": stats, "areas": per}
        action = {"type": "select_areas", "names": matched,
                  "report": bool(args.get("generate_report"))}
        return result, action

    if name == "set_map_boundary":
        b = str(args.get("boundary") or "")
        if b in BOUNDARY_KEYS:
            return {"ok": True, "boundary": b}, {"type": "set_boundary", "boundary": b}
        return {"ok": False, "error": "unknown boundary"}, None

    if name == "set_map_metric":
        m = str(args.get("metric") or "")
        if m in METRIC_BY_KEY:
            return {"ok": True, "metric": m}, {"type": "set_metric", "metric": m}
        return {"ok": False, "error": "unknown metric"}, None

    if name == "set_map_period":
        p = str(args.get("period") or "")
        if p in PERIOD_KEYS:
            return {"ok": True, "period": p}, {"type": "set_period", "period": p}
        return {"ok": False, "error": "unknown period"}, None

    if name == "set_map_filters":
        patch = args.get("filters") or {}
        clean = {}
        for key in ("saleMin", "saleMax", "rentMin", "rentMax", "bedsMin", "bedsMax",
                    "bathsMin", "bathsMax", "sqftMin", "sqftMax", "yearMin", "yearMax"):
            if key in patch and isinstance(patch[key], (int, float)):
                clean[key] = patch[key]
        if patch.get("pool") in ("any", "yes", "no"):
            clean["pool"] = patch["pool"]
        return {"ok": True, "applied": clean}, {"type": "set_filters", "filters": clean}

    if name == "get_area_stats":
        matched = _match_areas(boundary, args.get("areas") or [])
        stats = engine.area_stats(filters, period, matched or None, boundary)
        values = engine.aggregate_by_name(metric, boundary, filters, period)
        return {
            "matched": matched,
            "stats": stats,
            "areas": [{"name": m, "value": (values.get(m) or {}).get("value"),
                       "count": (values.get(m) or {}).get("count", 0)} for m in matched],
        }, None

    if name == "ask_interactive_question":
        return {"ok": True}, {
            "type": "ask",
            "question": args.get("question") or "",
            "options": args.get("options") or [],
            "multi": bool(args.get("multi_select")),
        }

    return {"ok": False, "error": "unknown tool"}, None


def reply(messages: list[dict], context: dict) -> dict:
    """Run the chat turn: model -> tools -> model -> {reply, actions}."""
    _CONTEXT["value"] = context or {}
    contents = []
    for m in messages or []:
        role = "model" if m.get("role") == "assistant" else "user"
        text = m.get("content") or ""
        if not text:
            continue
        contents.append({"role": role, "parts": [{"text": text}]})
    if not contents:
        return {"reply": "Tell me which area or what you would like to analyse.", "actions": []}

    actions = []
    data = _gemini(contents)
    for _ in range(3):
        cand = (data.get("candidates") or [{}])[0]
        parts = ((cand.get("content") or {}).get("parts")) or []
        calls = [p["functionCall"] for p in parts if "functionCall" in p]
        texts = [p.get("text", "") for p in parts if p.get("text")]

        if not calls:
            return {"reply": ("\n".join(t for t in texts if t).strip()
                              or "I could not find an answer for that."), "actions": actions}

        contents.append({"role": "model", "parts": parts})
        responses = []
        for call in calls:
            name = call.get("name") or ""
            args = call.get("args") or {}
            try:
                result, action = _execute(name, args, context)
            except Exception as exc:  # noqa: BLE001
                result, action = {"ok": False, "error": str(exc)[:200]}, None
            if action:
                actions.append(action)
            responses.append({"functionResponse": {"name": name, "response": result}})
        contents.append({"role": "user", "parts": responses})
        data = _gemini(contents)

    cand = (data.get("candidates") or [{}])[0]
    parts = ((cand.get("content") or {}).get("parts")) or []
    text = "\n".join(p.get("text", "") for p in parts if p.get("text")).strip()
    return {"reply": text or "Done.", "actions": actions}
