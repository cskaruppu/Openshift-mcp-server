export function WidgetCard({ title, className, children }) {
  return (
    <div className={`widget-card${className ? " " + className : ""}`}>
      <h3 className="widget-title">{title}</h3>
      <div className="widget-body">{children}</div>
    </div>
  );
}
