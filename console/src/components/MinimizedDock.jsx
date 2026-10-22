import { createPortal } from "react-dom";

/* One dock for every minimised panel.

   The Automation Hub and the Agent Registry can both be open, and both can be
   minimised. Each placing its own chip at the same bottom-right corner would
   stack one exactly on top of the other and hide it. So chips portal into a
   single fixed row instead, side by side — the way a taskbar holds more than
   one minimised window.

   The dock element is created on first use and left in place; an empty flex
   row takes no space and catches no clicks. */
function dockEl() {
  let el = document.getElementById("tcs-dock");
  if (!el) {
    el = document.createElement("div");
    el.id = "tcs-dock";
    el.className = "tcs-dock";
    document.body.appendChild(el);
  }
  return el;
}

export function DockChip({ label, onRestore }) {
  if (typeof document === "undefined") return null;
  return createPortal(
    <button className="ah-chip" onClick={onRestore}
      title={`Restore the ${label}`} aria-label={`Restore the ${label}`}>
      <img src="/brand/tcs-logo-white.png" alt="" width="1000" height="238" />
      <span>{label}</span>
      <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
        <path d="M2 6.5 5 3.5l3 3" fill="none" stroke="currentColor" strokeWidth="1.3" />
      </svg>
    </button>,
    dockEl(),
  );
}
