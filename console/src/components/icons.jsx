/* ── Line icons ───────────────────────────────────────────────────────────────
   Emoji were doing this job, and they cannot: 🚀 is a different drawing on
   Windows, macOS, Android and Linux, none of them matches the others, all of
   them are full colour, and every one reads as consumer software. A header
   using them cannot look like an enterprise product on a machine you do not
   control — which at a customer demo is every machine.

   So: inline SVG, one grid, one stroke weight, currentColor. They inherit the
   text colour, so an active tab's icon turns with its label and nothing has to
   be recoloured twice. 24px grid, 1.6 stroke, round caps and joins — the
   weight that stays legible at 16px and does not go spindly at 32.

   Drawn as OUTLINES rather than filled shapes: a filled glyph beside text at
   the same size always reads heavier than the text and pulls the eye off the
   label it is supposed to be introducing. */

const base = (size) => ({
  width: size, height: size, viewBox: "0 0 24 24", fill: "none",
  stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round",
  "aria-hidden": true, focusable: "false",
});

/** Deploying an application: a unit, lifted. */
export function IconDeploy({ size = 17 }) {
  return (
    <svg {...base(size)}>
      <path d="M12 3v8" />
      <path d="M9 6l3-3 3 3" />
      <rect x="4" y="13" width="16" height="7" rx="2" />
      <path d="M8 16.5h.01M11.5 16.5h5" />
    </svg>
  );
}

/** A change record: a ticket with a perforation, not a clipboard. */
export function IconTicket({ size = 17 }) {
  return (
    <svg {...base(size)}>
      <path d="M4 8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v1.2a2 2 0 0 0 0 5.6V16a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-1.2a2 2 0 0 0 0-5.6Z" />
      <path d="M9.5 10.5h5M9.5 13.5h3" />
    </svg>
  );
}

/** Migration: two estates and the crossing between them. The arrow is the
    subject, so it sits on the centre line and the boxes stay quiet. */
export function IconMigrate({ size = 17 }) {
  return (
    <svg {...base(size)}>
      <rect x="2.5" y="6" width="7" height="12" rx="1.6" />
      <rect x="14.5" y="6" width="7" height="12" rx="1.6" />
      <path d="M10.2 12h3.2" />
      <path d="M12.4 10.4 14 12l-1.6 1.6" />
    </svg>
  );
}

/**
 * The product mark.
 *
 * Deliberately NOT an attempt at the TCS logo. Reproducing a corporate mark
 * from memory gets it subtly wrong — proportion, weight, the exact curve — and
 * a nearly-right logo in front of the company that owns it is worse than an
 * honest neutral one. Drop the real asset in (see AutomationHub) and this is
 * replaced wholesale.
 *
 * What it draws meanwhile: a hub with agents around it, which is what the
 * product is. Geometric, monochrome, no gradient — a gradient-filled rounded
 * square with an emoji in it is the visual signature of an internal tool.
 */
export function ProductMark({ size = 22 }) {
  return (
    <svg {...base(size)} strokeWidth={1.7}>
      <circle cx="12" cy="12" r="2.6" />
      <circle cx="12" cy="3.6" r="1.9" />
      <circle cx="19.3" cy="16.2" r="1.9" />
      <circle cx="4.7" cy="16.2" r="1.9" />
      <path d="M12 5.5v3.9M13.9 13.5l3.7 1.9M10.1 13.5l-3.7 1.9" />
    </svg>
  );
}
