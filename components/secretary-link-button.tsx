"use client";

import { useId, useState } from "react";
import { createSecretaryLink, type SecretaryTarget } from "./secretary-ui-helpers";

export function SecretaryLinkButton({ target }: { target: SecretaryTarget }) {
  const [status, setStatus] = useState("");
  const [manualLink, setManualLink] = useState("");
  const inputId = useId();
  async function copy() {
    const link = createSecretaryLink(window.location.origin, target);
    if (!link) { setStatus("تعذر إنشاء رابط آمن."); return; }
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(link);
      setManualLink(""); setStatus("تم نسخ الرابط. فتحه يتطلب تسجيل الدخول وصلاحية العرض.");
    } catch {
      setManualLink(link); setStatus("يمكنك تحديد الرابط ونسخه يدويًا.");
    }
  }
  return <span className="titanium-link-control">
    <button type="button" className="titanium-copy-link" onClick={() => void copy()}>
      <span aria-hidden="true">↗</span> {target.taskId ? "نسخ رابط المهمة" : "نسخ رابط المشروع"}
    </button>
    <span className="titanium-link-status" role="status" aria-live="polite">{status}</span>
    {manualLink && <span className="titanium-manual-link">
      <label htmlFor={inputId}>رابط يتطلب صلاحية الدخول</label>
      <input id={inputId} dir="ltr" readOnly value={manualLink} onFocus={event => event.currentTarget.select()} />
    </span>}
  </span>;
}
