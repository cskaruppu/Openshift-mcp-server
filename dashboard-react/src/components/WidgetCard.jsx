/** Shared card chrome for dashboard widgets. */
export function WidgetCard({ title, children }) {
  return (
    <div className="widget-card">
      <div className="widget-title">{title}</div>
      <div className="widget-body">{children}</div>
    </div>
  );
}
