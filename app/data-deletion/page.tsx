import type { Metadata } from "next";
import Link from "next/link";
import LegalDocument from "@/components/legal-document";

const whatsappDeletionUrl = `https://wa.me/962793333798?text=${encodeURIComponent("حذف بياناتي | Delete my data")}`;

export const metadata: Metadata = {
  title: "تعليمات حذف البيانات | Titanium Management WhatsApp",
  description: "طريقة طلب حذف البيانات المرتبطة بخدمة Titanium Management WhatsApp.",
};

export default function DataDeletionPage() {
  return (
    <LegalDocument
      eyebrow="حذف البيانات · Data Deletion"
      title="طلب مباشر، بدون معلومات حساسة"
      summary="استخدم الخطوات التالية لطلب حذف البيانات المرتبطة بتفاعلك مع Titanium Management WhatsApp."
    >
      <aside className="titanium-legal-action" aria-labelledby="deletion-action-title">
        <div>
          <span>الطريقة الأساسية · Primary method</span>
          <h2 id="deletion-action-title">أرسل الطلب من نفس رقم WhatsApp</h2>
          <p>
            أرسل العبارة <strong>«حذف بياناتي | Delete my data»</strong> إلى حساب الخدمة الرسمي
            <bdi dir="ltr"> +962 79 333 3798</bdi>. استخدام نفس الرقم يساعدنا على تحديد السجلات الصحيحة.
          </p>
        </div>
        <a className="titanium-legal-button" href={whatsappDeletionUrl} rel="noreferrer">
          فتح الطلب في WhatsApp
          <span>Open request in WhatsApp</span>
        </a>
      </aside>

      <article className="titanium-legal-language" lang="ar" dir="rtl">
        <div className="titanium-legal-language-heading">
          <span>العربية</span>
          <h2>خطوات حذف البيانات</h2>
        </div>

        <ol className="titanium-legal-steps">
          <li>
            <span>1</span>
            <div><h3>أرسل الطلب</h3><p>استخدم الزر أعلاه أو أرسل العبارة المحددة من نفس رقم WhatsApp الذي استخدمته مع الخدمة.</p></div>
          </li>
          <li>
            <span>2</span>
            <div><h3>حدّد حساب النظام عند الحاجة</h3><p>إذا كان الطلب يشمل حساب الموقع الداخلي، أضف اسم العرض المستخدم في Titanium Management فقط.</p></div>
          </li>
          <li>
            <span>3</span>
            <div><h3>تحقق بسيط من الهوية</h3><p>قد يطلب مدير النظام تأكيد الطلب عبر نفس رقم WhatsApp أو من خلال حسابك الداخلي. لن نطلب كلمة مرور أو رمز تحقق.</p></div>
          </li>
          <li>
            <span>4</span>
            <div><h3>التنفيذ والتأكيد</h3><p>يراجع مدير النظام السجلات المرتبطة ويؤكد نتيجة الحذف عبر القناة نفسها.</p></div>
          </li>
        </ol>

        <section>
          <h3>ما الذي يشمله الطلب؟</h3>
          <p>
            يشمل الطلب بيانات تكامل WhatsApp المرتبطة برقمك، مثل رقم المرسل ومعرّفات الرسائل ونصوصها ونتائج
            المعالجة. تُحذف أو تُفصل عن هويتك بيانات الحساب الداخلي التي يمكن فصلها بصورة معقولة. قد تبقى
            بعض سجلات العمل الجماعي دون بيانات تعريف مباشرة إذا كان حذفها سيؤثر في سجل مهام الفريق.
          </p>
        </section>

        <section>
          <h3>ملاحظات مهمة</h3>
          <p>
            هذا الطلب يحذف البيانات التي يحتفظ بها Titanium Management؛ ولا يحذف حساب WhatsApp أو بيانات
            تحتفظ بها Meta بصورة مستقلة. إذا لم يكن حساب الخدمة متاحاً، قدّم الطلب مباشرة إلى مدير نظام
            Titanium Management داخل جهة عملك.
          </p>
        </section>
      </article>

      <article className="titanium-legal-language titanium-legal-language-en" lang="en" dir="ltr">
        <div className="titanium-legal-language-heading">
          <span>English</span>
          <h2>Data deletion steps</h2>
        </div>

        <ol className="titanium-legal-steps">
          <li>
            <span>1</span>
            <div><h3>Send the request</h3><p>Use the button above or send the stated phrase from the same WhatsApp number you used with the service.</p></div>
          </li>
          <li>
            <span>2</span>
            <div><h3>Identify your app account if needed</h3><p>If your request includes an internal website account, add only the display name used in Titanium Management.</p></div>
          </li>
          <li>
            <span>3</span>
            <div><h3>Complete a simple identity check</h3><p>The system administrator may confirm the request through the same WhatsApp number or your internal account. We will never ask for a password or verification code.</p></div>
          </li>
          <li>
            <span>4</span>
            <div><h3>Deletion and confirmation</h3><p>The system administrator reviews the associated records and confirms the deletion result through the same channel.</p></div>
          </li>
        </ol>

        <section>
          <h3>What does the request cover?</h3>
          <p>
            It covers WhatsApp integration data associated with your number, such as the sender number,
            message identifiers and text, and processing results. Internal account data that can reasonably be
            separated is deleted or de-identified. Some shared work records may remain without direct identifiers
            when removing them would impair the team&apos;s task history.
          </p>
        </section>

        <section>
          <h3>Important notes</h3>
          <p>
            This request deletes data held by Titanium Management. It does not delete your WhatsApp account or
            data that Meta holds independently. If the service account is unavailable, submit the request directly
            to your organization&apos;s Titanium Management system administrator.
          </p>
        </section>

        <p className="titanium-legal-inline-link">
          Read the <Link href="/privacy">Titanium Management Privacy Policy</Link>.
        </p>
      </article>
    </LegalDocument>
  );
}

