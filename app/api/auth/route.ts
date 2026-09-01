import {
  audit,
  checkLoginBlocked,
  clearLoginAttempts,
  createSession,
  db,
  destroySession,
  ensureSeedUsers,
  getSessionUser,
  hashPin,
  isPlatformAuthenticated,
  isSetupRequired,
  loginAttemptKey,
  recordFailedLogin,
  validPin,
  verifyPin,
} from "@/lib/titanium-server";

export async function GET(request: Request) {
  try {
    await ensureSeedUsers();
    const user = await getSessionUser(request);
    const users = await db().prepare("SELECT id, name, CASE WHEN pin_hash IS NULL THEN 0 ELSE 1 END AS pinSet FROM users WHERE active = 1 ORDER BY CASE WHEN id = 'basem' THEN 0 ELSE 1 END, created_at, name").all();
    return Response.json({
      authenticated: Boolean(user),
      user,
      users: users.results,
      setupRequired: await isSetupRequired(),
      platformAuthenticated: isPlatformAuthenticated(request),
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "تعذر فحص الدخول" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    await ensureSeedUsers();
    const body = await request.json() as Record<string, unknown>;
    const action = body.action;

    if (action === "setup") {
      if (!(await isSetupRequired())) {
        const pin = typeof body.pin === "string" ? body.pin : "";
        const existing = await db().prepare("SELECT id, name, role, active, pin_salt AS pinSalt, pin_hash AS pinHash FROM users WHERE id = 'basem'")
          .first<{ id:string; name:string; role:"admin"|"member"; active:number; pinSalt:string|null; pinHash:string|null }>();
        if (!existing || !existing.active || !(await verifyPin(pin, existing.pinSalt, existing.pinHash))) {
          return Response.json({ error: "تم إعداد المدير مسبقاً؛ حدّث الصفحة وسجّل الدخول" }, { status: 409 });
        }
        const user = { id:existing.id, name:existing.name, role:existing.role, active:existing.active };
        const session = await createSession(user, request);
        return Response.json({ authenticated: true, user, sessionToken:session.token }, { headers: { "set-cookie": session.cookie } });
      }
      if (!isPlatformAuthenticated(request)) return Response.json({ error: "الإعداد الأول متاح لمالك الموقع فقط" }, { status: 403 });
      if (!validPin(body.pin)) return Response.json({ error: "الكود يجب أن يكون من 4 إلى 8 أرقام" }, { status: 400 });
      const result = await hashPin(body.pin);
      const now = Date.now();
      await db().prepare("UPDATE users SET pin_salt = ?, pin_hash = ?, active = 1, role = 'admin', updated_at = ? WHERE id = 'basem'")
        .bind(result.salt, result.hash, now).run();
      const user = await db().prepare("SELECT id, name, role, active FROM users WHERE id = 'basem'").first<{ id:string; name:string; role:"admin"; active:number }>();
      if (!user) throw new Error("تعذر إعداد حساب باسم");
      await audit(user, "setup", "user", user.id, "تم إعداد حساب مدير النظام لأول مرة");
      const session = await createSession(user, request);
      return Response.json({ authenticated: true, user, sessionToken:session.token }, { headers: { "set-cookie": session.cookie } });
    }

    if (action === "login") {
      const userId = typeof body.userId === "string" ? body.userId : "";
      const pin = typeof body.pin === "string" ? body.pin : "";
      if (!userId || !validPin(pin)) return Response.json({ error: "اختر المستخدم واكتب الكود الصحيح" }, { status: 400 });
      const key = await loginAttemptKey(request, userId);
      const blockedUntil = await checkLoginBlocked(key);
      if (blockedUntil) {
        const minutes = Math.max(1, Math.ceil((blockedUntil - Date.now()) / 60000));
        return Response.json({ error: `محاولات كثيرة. جرّب بعد ${minutes} دقيقة` }, { status: 429 });
      }
      const user = await db().prepare("SELECT id, name, role, active, pin_salt AS pinSalt, pin_hash AS pinHash FROM users WHERE id = ?")
        .bind(userId).first<{ id:string; name:string; role:"admin"|"member"; active:number; pinSalt:string|null; pinHash:string|null }>();
      if (user && user.active && (!user.pinSalt || !user.pinHash)) {
        return Response.json({ error: "باسم لم يفعّل كود هذا المستخدم بعد" }, { status: 403 });
      }
      if (!user || !user.active || !(await verifyPin(pin, user.pinSalt, user.pinHash))) {
        const attempt = await recordFailedLogin(key);
        const suffix = attempt.blockedUntil ? " تم إيقاف المحاولات لمدة 15 دقيقة" : "";
        return Response.json({ error: `الكود غير صحيح.${suffix}` }, { status: 401 });
      }
      await clearLoginAttempts(key);
      await audit(user, "login", "user", user.id, "تم تسجيل الدخول");
      const session = await createSession(user, request);
      return Response.json({ authenticated: true, sessionToken:session.token, user: { id:user.id, name:user.name, role:user.role, active:user.active } }, { headers: { "set-cookie": session.cookie } });
    }

    if (action === "logout") {
      const user = await getSessionUser(request);
      if (user) await audit(user, "logout", "user", user.id, "تم تسجيل الخروج");
      return Response.json({ authenticated: false }, { headers: { "set-cookie": await destroySession(request) } });
    }

    return Response.json({ error: "الطلب غير معروف" }, { status: 400 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "تعذر تنفيذ الدخول" }, { status: 500 });
  }
}
