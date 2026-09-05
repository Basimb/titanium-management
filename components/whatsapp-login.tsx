"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { MessageCircle, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  clockLabel, internationalLoginPhone, isLoginChallenge, isWhatsAppLoginSuccess,
  loginCodeDigits, secondsUntil, type WhatsAppLoginSuccess,
} from "./whatsapp-login-helpers";

const GENERIC_SENT = "إذا كان رقمك مسجّلًا ومفعّلًا لدى الإدارة، ستصلك رسالة خاصة على واتساب فيها رمز الدخول.";

export function WhatsAppLogin({ onAuthenticated }: { onAuthenticated: (result: WhatsAppLoginSuccess) => Promise<void> | void }) {
  const [phase, setPhase] = useState<"phone" | "code">("phone");
  const [phoneInput, setPhoneInput] = useState("");
  const [sentPhone, setSentPhone] = useState("");
  const [code, setCode] = useState("");
  const [challengeId, setChallengeId] = useState("");
  const [expiresAt, setExpiresAt] = useState(0);
  const [retryAt, setRetryAt] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const busy = useRef(false);
  const mounted = useRef(true);
  const activeRequest = useRef<AbortController | null>(null);
  const phoneRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const retrySeconds = secondsUntil(retryAt, now);
  const expiresSeconds = secondsUntil(expiresAt, now);
  const samePhoneCooldown = internationalLoginPhone(phoneInput) === sentPhone ? retrySeconds : 0;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; activeRequest.current?.abort(); };
  }, []);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => { (phase === "phone" ? phoneRef : codeRef).current?.focus(); }, [phase]);

  async function post(payload: Record<string, string>): Promise<unknown> {
    const controller = new AbortController();
    activeRequest.current = controller;
    const timer = window.setTimeout(() => controller.abort(), 25_000);
    try {
      const response = await fetch("/api/auth", {
        method: "POST", credentials: "include", cache: "no-store",
        headers: { "content-type": "application/json" }, body: JSON.stringify(payload), signal: controller.signal,
      });
      const result: unknown = await response.json();
      if (!response.ok) {
        const message = result && typeof result === "object" && "error" in result && typeof result.error === "string"
          ? result.error.slice(0, 300) : "تعذر إكمال الطلب. حاول مرة ثانية.";
        throw new Error(message);
      }
      return result;
    } finally {
      window.clearTimeout(timer);
      if (activeRequest.current === controller) activeRequest.current = null;
    }
  }

  function showError(caught: unknown) {
    if (!mounted.current) return;
    setError(caught instanceof Error && caught.name === "Error"
      ? caught.message : "تعذر الاتصال. تأكد من الإنترنت وحاول مرة ثانية.");
  }

  async function requestCode(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (busy.current) return;
    const phone = phase === "code" ? sentPhone : internationalLoginPhone(phoneInput);
    if (!phone) { setError("اكتب رقم واتساب كاملًا مع مفتاح البلد، مثل +962 أو +966، بدون صفر محلي إضافي."); phoneRef.current?.focus(); return; }
    if (phone === sentPhone && secondsUntil(retryAt, Date.now()) > 0) return;
    busy.current = true; setPending(true); setError("");
    const requestedAt = Date.now();
    try {
      const result = await post({ action: "request-code", phone });
      if (!mounted.current) return;
      if (!isLoginChallenge(result)) throw new Error("تعذر تجهيز رمز الدخول. حاول مرة ثانية.");
      const receivedAt = Date.now();
      setSentPhone(phone); setPhoneInput(phone); setCode(""); setChallengeId(result.challengeId);
      setExpiresAt(requestedAt + result.expiresInSeconds * 1000);
      setRetryAt(receivedAt + result.retryAfterSeconds * 1000); setNow(receivedAt);
      setNotice(GENERIC_SENT); setPhase("code");
      codeRef.current?.focus();
    } catch (caught) { showError(caught); }
    finally { busy.current = false; if (mounted.current) setPending(false); }
  }

  async function verifyCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy.current) return;
    if (!/^\d{6}$/.test(code)) { setError("اكتب رمز الدخول المكوّن من 6 أرقام."); codeRef.current?.focus(); return; }
    if (!challengeId || secondsUntil(expiresAt, Date.now()) === 0) { setError("انتهت صلاحية الرمز. اطلب رمزًا جديدًا."); return; }
    busy.current = true; setPending(true); setError("");
    try {
      const result = await post({ action: "verify-code", phone: sentPhone, challengeId, code });
      if (!mounted.current) return;
      if (!isWhatsAppLoginSuccess(result)) throw new Error("تعذر تأكيد الدخول. حاول مرة ثانية.");
      setCode(""); setChallengeId("");
      await onAuthenticated(result);
    } catch (caught) { showError(caught); }
    finally { busy.current = false; if (mounted.current) setPending(false); }
  }

  function changeNumber() {
    if (busy.current) return;
    setCode(""); setChallengeId(""); setExpiresAt(0); setError(""); setNotice(""); setPhase("phone");
  }

  return <div className="titanium-whatsapp-login">
    <div className="titanium-login-method"><MessageCircle aria-hidden="true" /><span>دخول برمز مؤقت على واتساب</span></div>
    {phase === "phone" ? <form className="titanium-dialog-grid" onSubmit={requestCode} noValidate aria-busy={pending}>
      <div className="titanium-field">
        <label htmlFor="whatsapp-login-phone">رقم واتساب المسجّل لدى الإدارة</label>
        <Input ref={phoneRef} id="whatsapp-login-phone" name="phone" type="tel" inputMode="tel" autoComplete="tel"
          dir="ltr" className="titanium-login-phone" placeholder="+9627XXXXXXXX" maxLength={32}
          value={phoneInput} onChange={event => { setPhoneInput(event.target.value); setError(""); }}
          disabled={pending} aria-invalid={Boolean(error)} aria-describedby={error ? "whatsapp-phone-help whatsapp-login-error" : "whatsapp-phone-help"} />
        <p id="whatsapp-phone-help" className="titanium-dialog-note">اكتب مفتاح البلد مع الرقم: +962 للأردن، أو +966 للسعودية.</p>
      </div>
      {error && <p id="whatsapp-login-error" role="alert" className="titanium-warning">{error}</p>}
      <Button type="submit" disabled={pending || !phoneInput.trim() || samePhoneCooldown > 0}>
        {pending ? "جارٍ طلب الرمز…" : samePhoneCooldown > 0 ? `يمكن طلب رمز جديد بعد ${samePhoneCooldown} ثانية` : "أرسل رمز الدخول على واتساب"}
      </Button>
      <p className="titanium-login-security"><ShieldCheck aria-hidden="true" />الرمز لمرة واحدة. لا تشاركه مع أي شخص.</p>
    </form> : <form className="titanium-dialog-grid" onSubmit={verifyCode} noValidate aria-busy={pending}>
      <p className="titanium-login-sent" role="status" aria-live="polite">{notice}</p>
      <p className="titanium-login-number">الرقم الذي أدخلته: <bdi dir="ltr">{sentPhone}</bdi></p>
      <div className="titanium-field">
        <label htmlFor="whatsapp-login-code">رمز الدخول من 6 أرقام</label>
        <Input ref={codeRef} id="whatsapp-login-code" name="code" type="text" inputMode="numeric" autoComplete="one-time-code"
          dir="ltr" className="titanium-login-code" placeholder="000000" maxLength={6} pattern="[0-9]{6}"
          value={code} onChange={event => { setCode(loginCodeDigits(event.target.value)); setError(""); }}
          onPaste={event => { event.preventDefault(); setCode(loginCodeDigits(event.clipboardData.getData("text"))); setError(""); }}
          disabled={pending || expiresSeconds === 0} aria-invalid={Boolean(error)}
          aria-describedby={error ? "whatsapp-code-help whatsapp-login-error" : "whatsapp-code-help"} />
        <p id="whatsapp-code-help" className="titanium-dialog-note" aria-live="off">
          {expiresSeconds > 0 ? <>صلاحية الرمز المتبقية: <bdi dir="ltr">{clockLabel(expiresSeconds)}</bdi></> : "انتهت صلاحية الرمز. اضغط إعادة إرسال الرمز للحصول على رمز جديد."}
        </p>
      </div>
      {error && <p id="whatsapp-login-error" role="alert" className="titanium-warning">{error}</p>}
      <Button type="submit" disabled={pending || code.length !== 6 || expiresSeconds === 0}>{pending ? "جارٍ التحقق…" : "تأكيد الرمز والدخول"}</Button>
      <div className="titanium-login-code-actions">
        <Button type="button" variant="outline" disabled={pending || retrySeconds > 0} onClick={() => void requestCode()}>
          {retrySeconds > 0 ? `إعادة الإرسال بعد ${retrySeconds} ثانية` : "إعادة إرسال الرمز"}
        </Button>
        <Button type="button" variant="ghost" disabled={pending} onClick={changeNumber}>تغيير الرقم</Button>
      </div>
      <p className="titanium-dialog-note">إذا لم تصلك رسالة، تأكد من رقمك ومفتاح البلد، أو تواصل مع باسم للتحقق من تسجيل رقمك.</p>
    </form>}
  </div>;
}
