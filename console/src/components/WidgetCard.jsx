import { useViewStore } from "../store/viewStore";

export function WidgetCard({ title, className, linkTo, linkLabel, children }) {
  const setView = useViewStore((s) => s.setActiveView);

  return (
    <div className={`widget-card${className ? " " + className : ""}`}>
      <div className="widget-header">
        <h3 className="widget-title">{title}</h3>
        {linkTo && (
          <button className="widget-link" onClick={() => setView(linkTo)}>
            {linkLabel || "View"} &rarr;
          </button>
        )}
      </div>
      <div className="widget-body">{children}</div>
    </div>
  );
}
