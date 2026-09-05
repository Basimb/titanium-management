"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { MessageCircle, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  clockLabel, isLoginChallenge, isWhatsAppLoginSuccess, publicWhatsAppLoginUsers,
  loginCodeDigits, secondsUntil, type WhatsAppLoginSuccess, type WhatsAppLoginUser,
} from "./whatsapp-login-helpers";

const GENERIC_SENT = "إذا كان الحساب المختار مفعّلًا ورقمه مسجّلًا، سيصله رمز الدخول برسالة خاصة على واتساب المسجّل لدى الإدارة.";

export function WhatsAppLogin({ users, onAuthenticated }: {
  users: WhatsAppLoginUser[];
  onAuthenticated: (result: WhatsAppLoginSuccess) => Promise<void> | void;
}) {
  const availableUsers = publicWhatsAppLoginUsers(users);
  const [phase, setPhase] = useState<"user" | "code">("user");
  const [selectedUserId, setSelectedUserId] = useState("");
  const [sentUserId, setSentUserId] = useState("");
  const [sentUserName, setSentUserName] = useState("");
  const [code, setCode] = useState("");
  const [challengeId, setChallengeId] = useState("");
  const [expiresAt, setExpiresAt] = useState(0);
  const [retryByUser, setRetryByUser] = useState<Map<string, number>>(() => new Map());
  const [now, setNow] = useState(() => Date.now());
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const busy = useRef(false);
  const mounted = useRef(true);
  const activeRequest = useRef<AbortController | null>(null);
  const userRef = useRef<HTMLSelectElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const selectedUser = availableUsers.find(user => user.id === selectedUserId);
  const sentUserAvailable = availableUsers.some(user => user.id === sentUserId);
  const retrySeconds = secondsUntil(retryByUser.get(sentUserId) ?? 0, now);
  const expiresSeconds = secondsUntil(expiresAt, now);
  const selectedUserCooldown = secondsUntil(retryByUser.get(selectedUserId) ?? 0, now);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; activeRequest.current?.abort(); };
  }, []);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => { (phase === "user" ? userRef : codeRef).current?.focus(); }, [phase]);

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
    const userId = phase === "code" ? sentUserId : selectedUserId;
    const user = availableUsers.find(candidate => candidate.id === userId);
    if (!user) { setError("اختر اسمك من قائمة الموظفين المسجّلين أولًا."); userRef.current?.focus(); return; }
    if (secondsUntil(retryByUser.get(userId) ?? 0, Date.now()) > 0) return;
    busy.current = true; setPending(true); setError("");
    const requestedAt = Date.now();
    try {
      const result = await post({ action: "request-code", userId });
      if (!mounted.current) return;
      if (!isLoginChallenge(result)) throw new Error("تعذر تجهيز رمز الدخول. حاول مرة ثانية.");
      const receivedAt = Date.now();
      setSentUserId(userId); setSentUserName(user.name); setSelectedUserId(userId); setCode(""); setChallengeId(result.challengeId);
      setExpiresAt(requestedAt + result.expiresInSeconds * 1000);
      setRetryByUser(current => new Map(current).set(userId, receivedAt + result.retryAfterSeconds * 1000)); setNow(receivedAt);
      setNotice(GENERIC_SENT); setPhase("code");
      codeRef.current?.focus();
    } catch (caught) { showError(caught); }
    finally { busy.current = false; if (mounted.current) setPending(false); }
  }

  async function verifyCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy.current) return;
    if (!sentUserAvailable) { setError("الحساب المختار غير متاح الآن. اختر اسمك مجددًا."); return; }
    if (!/^\d{6}$/.test(code)) { setError("اكتب رمز الدخول المكوّن من 6 أرقام."); codeRef.current?.focus(); return; }
    if (!challengeId || secondsUntil(expiresAt, Date.now()) === 0) { setError("انتهت صلاحية الرمز. اطلب رمزًا جديدًا."); return; }
    busy.current = true; setPending(true); setError("");
    try {
      const result = await post({ action: "verify-code", userId: sentUserId, challengeId, code });
      if (!mounted.current) return;
      if (!isWhatsAppLoginSuccess(result) || result.user.id !== sentUserId) throw new Error("تعذر تأكيد الدخول. حاول مرة ثانية.");
      setCode(""); setChallengeId("");
      await onAuthenticated(result);
    } catch (caught) { showError(caught); }
    finally { busy.current = false; if (mounted.current) setPending(false); }
  }

  function changeUser() {
    if (busy.current) return;
    setCode(""); setChallengeId(""); setExpiresAt(0); setSentUserId(""); setSentUserName("");
    setSelectedUserId(""); setError(""); setNotice(""); setPhase("user");
  }

  return <div className="titanium-whatsapp-login">
    <div className="titanium-login-method"><MessageCircle aria-hidden="true" /><span>دخول برمز مؤقت على واتساب</span></div>
    {phase === "user" ? <form className="titanium-dialog-grid" onSubmit={requestCode} noValidate aria-busy={pending}>
      <div className="titanium-field">
        <label htmlFor="whatsapp-login-user">اختر اسمك</label>
        <select ref={userRef} id="whatsapp-login-user" name="userId" autoComplete="off" dir="rtl"
          className="h-11 w-full rounded-md border border-input bg-background px-3 text-base shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
          value={selectedUserId} onChange={event => { setSelectedUserId(event.target.value); setError(""); }}
          disabled={pending || availableUsers.length === 0} aria-invalid={Boolean(error)}
          aria-describedby={error ? "whatsapp-user-help whatsapp-login-error" : "whatsapp-user-help"}>
          <option value="" disabled>اختر اسمك</option>
          {availableUsers.map(user => <option key={user.id} value={user.id}>{user.name}</option>)}
        </select>
        <p id="whatsapp-user-help" className="titanium-dialog-note">سيُرسل الرمز إلى واتساب المسجّل للاسم المختار، دون الحاجة لكتابة الرقم.</p>
        {availableUsers.length === 0 && <p className="titanium-warning" role="alert">لا توجد أسماء متاحة للدخول الآن. حدّث الصفحة أو تواصل مع باسم.</p>}
      </div>
      {error && <p id="whatsapp-login-error" role="alert" className="titanium-warning">{error}</p>}
      <Button type="submit" disabled={pending || !selectedUser || selectedUserCooldown > 0}>
        {pending ? "جارٍ طلب الرمز…" : selectedUserCooldown > 0 ? `يمكن طلب رمز جديد بعد ${selectedUserCooldown} ثانية` : "أرسل رمز الدخول على واتساب"}
      </Button>
      <p className="titanium-login-security"><ShieldCheck aria-hidden="true" />الرمز لمرة واحدة. لا تشاركه مع أي شخص.</p>
    </form> : <form className="titanium-dialog-grid" onSubmit={verifyCode} noValidate aria-busy={pending}>
      <p className="titanium-login-sent" role="status" aria-live="polite">{notice}</p>
      <p className="titanium-login-number">الاسم المختار: <bdi dir="auto">{sentUserName}</bdi></p>
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
      <Button type="submit" disabled={pending || !sentUserAvailable || code.length !== 6 || expiresSeconds === 0}>{pending ? "جارٍ التحقق…" : "تأكيد الرمز والدخول"}</Button>
      <div className="titanium-login-code-actions">
        <Button type="button" variant="outline" disabled={pending || !sentUserAvailable || retrySeconds > 0} onClick={() => void requestCode()}>
          {retrySeconds > 0 ? `إعادة الإرسال بعد ${retrySeconds} ثانية` : "إعادة إرسال الرمز"}
        </Button>
        <Button type="button" variant="ghost" disabled={pending} onClick={changeUser}>تغيير الاسم</Button>
      </div>
      <p className="titanium-dialog-note">إذا لم تصلك رسالة، تأكد أنك اخترت اسمك، أو تواصل مع باسم للتحقق من رقم واتساب المسجّل لك.</p>
    </form>}
  </div>;
}
