import { secretaryAuditView, type SecretaryTarget, type SecretaryViewer } from "./secretary-ui-helpers";

type Activity = {
  id: number; actorName: string; action: string; details: string; createdAt: number;
};

export function SecretaryActivity({ activity, viewer, target, onOpen }: {
  activity: Activity; viewer: SecretaryViewer; target: SecretaryTarget | null;
  onOpen: (target: SecretaryTarget) => void;
}) {
  const view = secretaryAuditView(activity, viewer);
  const at = new Date(activity.createdAt);
  const validDate = Number.isFinite(at.getTime());
  return <article className={`titanium-activity-row${view.isSecretary ? " titanium-secretary-activity" : ""}`}>
    <span className="titanium-activity-icon" aria-hidden="true">{view.isSecretary ? "و" : "•"}</span>
    <div className="titanium-activity-content">
      <strong>{activity.actorName}</strong>
      {view.isSecretary && <span className="titanium-secretary-badge">سكرتير الإدارة · واتساب</span>}
      <p>{view.summary}</p>
      {view.isSecretary && (view.fields.length > 0 || view.senderNumber) && <details className="titanium-secretary-audit">
        <summary>تفاصيل طلب السكرتير وتأكيده</summary>
        <dl>
          <div><dt>صاحب الإجراء</dt><dd>{activity.actorName}</dd></div>
          {view.fields.map(field => <div key={field.label}><dt>{field.label}</dt><dd>{field.value}</dd></div>)}
          {view.senderNumber && <div><dt>رقم المرسل الأصلي · للمدير فقط</dt><dd dir="ltr">{view.senderNumber}</dd></div>}
        </dl>
      </details>}
      {target && <button type="button" className="titanium-activity-open" onClick={() => onOpen(target)}>
        {target.taskId ? "فتح المهمة" : "فتح المشروع"}
      </button>}
    </div>
    <time dateTime={validDate ? at.toISOString() : undefined}>{validDate ? at.toLocaleString("ar-JO") : "التاريخ غير متاح"}</time>
  </article>;
}
