# Deviations Log

> Format: date | TASK-nn | doc amended | why

2026-07-11 | TASK-10 | promptgate.md Rule 15, 00-prd.md REQ-10/OPEN-02, 04-schema.md ENT-03, 05-implementation-plan.md TASK-10 | OPEN-02 research proved winget cannot be a runtime lookup source (default source is a network REST API, blocked by Rule 6; also no offline manifest cache and no UninstallerSwitches output). Lookup chain reduced from 3 steps to 2: corrections.json (primary) -> heuristic fallback. Pre-implementation amendment (research gate, not a mid-code drift).
