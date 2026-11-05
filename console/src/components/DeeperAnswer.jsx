import { useEffect, useRef, useState } from "react";

// AI Chat, under a Private AI answer that came from a stand-in model because
// the model the question needed was asleep (services/private-ai/autosleep.js):
// says so, waits for that model, and asks it the same question when it is up.

const OVERRIDE = { large: "@deep", small: "@fast", coder: "@code" };

export default function DeeperAnswer({ waking, question, onAsk, busy }) {
  const [state, setState] = useState("waiting");   // waiting | ready | asked | blocked | gone
  const [detail, setDetail] = useState(null);
  const asked = useRef(false);
  const prefix = OVERRIDE[waking.role];
  const t0 = useRef(Date.now());

  useEffect(() => {
    if (!prefix) { setState("gone"); return undefined; }
    let live = true;
    const check = async () => {
      try {
        const r = await fetch("/api/command-center/autosleep");
        const j = r.ok ? await r.json() : null;
        const row = j?.models?.[waking.model];
        if (!live || !row) return;
        if (row.blocked && (!row.woke || Date.parse(row.blocked.at) > Date.parse(row.woke.at))) { setState("blocked"); setDetail(row.blocked.reason); return; }
        if (row.woke?.readyAt) { setState((s) => (s === "asked" ? s : "ready")); return; }
        if (Date.now() - t0.current > 15 * 60_000) setState("gone");
      } catch { /* try again next time */ }
    };
    check();
    const t = setInterval(check, 10_000);
    return () => { live = false; clearInterval(t); };
  }, [waking.model, prefix]);

  // Ask once, when the model is up and the chat is free.
  useEffect(() => {
    if (state === "ready" && !busy && !asked.current && question) {
      asked.current = true; setState("asked");
      onAsk(`${prefix} ${question}`);
    }
  }, [state, busy, question, prefix, onAsk]);

  if (state === "gone") return null;
  const mins = waking.lastWakeSeconds ? Math.max(1, Math.round(waking.lastWakeSeconds / 60)) : null;
  return (
    <div className={"ac-deeper " + state}>
      <span className="ac-deeper-dot" aria-hidden="true" />
      {state === "waiting" && <span><b>{waking.model}</b> was asleep and is starting{mins ? ` (about ${mins} min)` : ""}. This answer came from a faster model; {waking.model} will be asked the same question as soon as it is up, and its answer will appear below.</span>}
      {state === "ready" && <span><b>{waking.model}</b> is up — asking it now…</span>}
      {state === "asked" && <span>Asked <b>{waking.model}</b> the same question: its answer is below.</span>}
      {state === "blocked" && <span><b>{waking.model}</b> could not start: {detail}.</span>}
    </div>
  );
}
