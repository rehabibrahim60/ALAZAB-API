import express, { json } from 'express';
import { connect, Schema, model } from 'mongoose';
import { Resend } from 'resend';
import cors from 'cors';
import dotenv from 'dotenv';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { v2 as cloudinary } from 'cloudinary';
import { CloudinaryStorage } from 'multer-storage-cloudinary';
import rateLimit from 'express-rate-limit';

dotenv.config();

const resend = new Resend(process.env.RESEND_API_KEY);

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app = express();
app.use(json());
app.use(cors());


// ──────────────────────────────────────────────
//  Rate Limiting
// ──────────────────────────────────────────────

// 🌐 حد عام — لكل الـ routes
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 دقيقة
  max: 100,                  // 100 request كل 15 دقيقة لكل IP
  message: { success: false, message: 'طلبات كتير جداً، انتظر شوية وحاول تاني' },
  standardHeaders: true,
  legacyHeaders: false,
});

// 🔐 حد صارم للـ Login — عشان يمنع Brute Force
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 دقيقة
  max: 10,                   // 10 محاولات بس
  message: { success: false, message: 'محاولات تسجيل دخول كتير، انتظر 15 دقيقة' },
  standardHeaders: true,
  legacyHeaders: false,
});

// 📩 حد للـ Forms — contact / faq / join
const formLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // ساعة
  max: 50,                    // 5 submissions في الساعة
  message: { success: false, message: 'بعتَ كتير، حاول بعد ساعة' },
  standardHeaders: true,
  legacyHeaders: false,
});

// طبّق الـ global على كل الـ app
app.use(globalLimiter);



// ──────────────────────────────────────────────
//  Cloudinary Config
// ──────────────────────────────────────────────
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ──────────────────────────────────────────────
//  Cloudinary Storage — صور الأخبار
// ──────────────────────────────────────────────
const sharedStorage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder:          'alazab/news',
    allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],
  },
});

const upload = multer({
  storage: sharedStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
});

// ──────────────────────────────────────────────
//  Cloudinary Storage — السيرة الذاتية
// ──────────────────────────────────────────────
const cvStorage = new CloudinaryStorage({
  cloudinary,
  params: (req, file) => ({
    folder:          'alazab/cvs',
    resource_type:   'raw',
    allowed_formats: ['pdf'],
    public_id:       Date.now() + '_' + file.originalname.replace(/\s/g, '_'),
  }),
});



const uploadCV = multer({
  storage: cvStorage,
  limits: { fileSize: 2 * 1024 * 1024 },
});

// ──────────────────────────────────────────────
//  Cloudinary Storage — المرفقات
// ──────────────────────────────────────────────
const attachmentStorage = new CloudinaryStorage({
  cloudinary,
  params: (req, file) => ({
    folder:        'alazab/attachments',
    resource_type: /\.(jpe?g|png|gif)$/i.test(file.originalname) ? 'image' : 'raw',
    allowed_formats: ['pdf', 'doc', 'docx', 'jpg', 'jpeg', 'png', 'gif', 'txt'],
  }),
});

const uploadAttachment = multer({
  storage: attachmentStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
});

// ──────────────────────────────────────────────
//  Helper — استخرج public_id من Cloudinary URL
// ──────────────────────────────────────────────
function getPublicId(url) {
  try {
    // مثال: https://res.cloudinary.com/xxx/image/upload/v123/alazab/news/filename.jpg
    // نريد: alazab/news/filename
    const parts = url.split('/');
    const uploadIndex = parts.indexOf('upload');
    // نشيل الـ version (v123456) لو موجود
    const afterUpload = parts.slice(uploadIndex + 1);
    if (afterUpload[0]?.startsWith('v') && /^v\d+$/.test(afterUpload[0])) {
      afterUpload.shift();
    }
    const withExt = afterUpload.join('/');
    return withExt.replace(/\.[^/.]+$/, ''); // شيل الـ extension
  } catch {
    return null;
  }
}

function toInlineUrl(url) {
  if (!url) return '';
  // ✅ Google Docs Viewer بيفتح أي PDF في المتصفح
  return `https://docs.google.com/viewer?url=${encodeURIComponent(url)}&embedded=true`;
}





// ──────────────────────────────────────────────
//  ✅ NEWS JSON GENERATOR
// ──────────────────────────────────────────────
const NEWS_JSON_PATH = path.join(__dirname, '../alazab/news-data.txt');
async function updateNewsJson() {
  try {
    const news = await News.find({ published: true }).sort({ createdAt: -1 });
    const payload = JSON.stringify({ success: true, data: news }, null, 2);
    fs.writeFileSync(NEWS_JSON_PATH, payload, 'utf8');
    console.log(`✅ news-data.json updated — ${news.length} item(s)`);
  } catch (err) {
    console.error('❌ Failed to update news-data.json:', err.message);
  }
}

// ──────────────────────────────────────────────
//  MongoDB
// ──────────────────────────────────────────────
connect(process.env.MONGO_URI)
  .then(() => {
    console.log('✅ MongoDB connected');
    updateNewsJson();
  })
  .catch(err => console.error('❌ MongoDB error:', err));

// ──────────────────────────────────────────────
//  Schemas & Models
// ──────────────────────────────────────────────
const AdminUser = model('AdminUser', new Schema({
  username:  { type: String, required: true, unique: true, trim: true, lowercase: true },
  password:  { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
}));

const Inquiry = model('Inquiry', new Schema({
  firstName:     { type: String, required: true, trim: true },
  lastName:      { type: String, required: true, trim: true },
  phone:         { type: String, required: true, trim: true },
  email:         { type: String, required: true, trim: true, lowercase: true },
  details:       { type: String, required: true, trim: true },
  attachmentUrl: { type: String, default: '' },
  createdAt:     { type: Date, default: Date.now },
}));

const FaqQuestion = model('FaqQuestion', new Schema({
  fullName:      { type: String, required: true, trim: true },
  email:         { type: String, required: true, trim: true, lowercase: true },
  question:      { type: String, required: true, trim: true },
  status:        { type: String, enum: ['pending', 'answered'], default: 'pending' },
  attachmentUrl: { type: String, default: '' },
  createdAt:     { type: Date, default: Date.now },
}));

const News = model('News', new Schema({
  title_ar:  { type: String, required: true, trim: true },
  body_ar:   { type: String, required: true, trim: true },
  title_en:  { type: String, default: '', trim: true },
  body_en:   { type: String, default: '', trim: true },
  title:     { type: String, default: '', trim: true },
  body:      { type: String, default: '', trim: true },
  imageUrl:  { type: String, default: '' },
  link:      { type: String, default: '' },
  published: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now },
}));

const JoinApplication = model('JoinApplication', new Schema({
  firstName:     { type: String, required: true, trim: true },
  lastName:      { type: String, required: true, trim: true },
  phone:         { type: String, required: true, trim: true },
  email:         { type: String, required: true, trim: true, lowercase: true },
  details:       { type: String, required: true, trim: true },
  country:       { type: String, default: '', trim: true },
  cvUrl:         { type: String, default: '' },
  attachmentUrl: { type: String, default: '' },
  createdAt:     { type: Date, default: Date.now },
}));

// ──────────────────────────────────────────────
//  JWT helpers
// ──────────────────────────────────────────────
const JWT_SECRET  = process.env.JWT_SECRET  || 'change_this_secret_in_production';
const JWT_EXPIRES = process.env.JWT_EXPIRES || '8h';

function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}

function authenticate(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token)
    return res.status(401).json({ success: false, message: 'غير مصرح — الرجاء تسجيل الدخول أولاً' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    const msg = err.name === 'TokenExpiredError'
      ? 'انتهت صلاحية الجلسة — الرجاء إعادة تسجيل الدخول'
      : 'توكن غير صالح';
    res.status(401).json({ success: false, message: msg });
  }
}

// ──────────────────────────────────────────────
//  AUTH routes
// ──────────────────────────────────────────────
app.post('/auth/login', authLimiter , async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password)
      return res.status(400).json({ success: false, message: 'اسم المستخدم وكلمة المرور مطلوبان' });
    const user = await AdminUser.findOne({ username: username.toLowerCase().trim() });
    if (!user || !(await bcrypt.compare(password, user.password)))
      return res.status(401).json({ success: false, message: 'بيانات تسجيل الدخول غير صحيحة' });
    const token = signToken({ id: user._id, username: user.username });
    res.json({ success: true, message: 'تم تسجيل الدخول بنجاح', token, expiresIn: JWT_EXPIRES,
               user: { id: user._id, username: user.username } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'حدث خطأ في الخادم' });
  }
});

app.post('/auth/logout', authenticate, (req, res) =>
  res.json({ success: true, message: 'تم تسجيل الخروج' }));

app.get('/auth/me', authenticate, async (req, res) => {
  try {
    const user = await AdminUser.findById(req.user.id).select('-password');
    if (!user) return res.status(404).json({ success: false, message: 'المستخدم غير موجود' });
    res.json({ success: true, data: user });
  } catch { res.status(500).json({ success: false, message: 'Server error' }); }
});

app.patch('/auth/change-password', authenticate, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword)
      return res.status(400).json({ success: false, message: 'كلمة المرور الحالية والجديدة مطلوبتان' });
    if (newPassword.length < 8)
      return res.status(400).json({ success: false, message: 'كلمة المرور الجديدة يجب أن تكون 8 أحرف على الأقل' });
    const user = await AdminUser.findById(req.user.id);
    if (!(await bcrypt.compare(currentPassword, user.password)))
      return res.status(401).json({ success: false, message: 'كلمة المرور الحالية غير صحيحة' });
    user.password = await bcrypt.hash(newPassword, 12);
    await user.save();
    res.json({ success: true, message: 'تم تغيير كلمة المرور بنجاح' });
  } catch { res.status(500).json({ success: false, message: 'Server error' }); }
});

// ──────────────────────────────────────────────
//  Seed helper
// ──────────────────────────────────────────────
if (process.env.SEED_ADMIN === 'true') {
  connect(process.env.MONGO_URI).then(async () => {
    const exists = await AdminUser.findOne({ username: process.env.SEED_USERNAME });
    if (!exists) {
      const hashed = await bcrypt.hash(process.env.SEED_PASSWORD, 12);
      await new AdminUser({ username: process.env.SEED_USERNAME, password: hashed }).save();
      console.log(`✅ Admin created: ${process.env.SEED_USERNAME}`);
    } else {
      console.log('ℹ️  Admin already exists.');
    }
    process.exit(0);
  });
}

// ──────────────────────────────────────────────
//  NEWS routes
// ──────────────────────────────────────────────
app.get('/news', async (req, res) => {
  try {
    const news = await News.find({ published: true }).sort({ createdAt: -1 });
    res.json({ success: true, count: news.length, data: news });
  } catch { res.status(500).json({ success: false, message: 'Server error' }); }
});

app.get('/news/all', authenticate, async (req, res) => {
  try {
    const news = await News.find().sort({ createdAt: -1 });
    res.json({ success: true, count: news.length, data: news });
  } catch { res.status(500).json({ success: false, message: 'Server error' }); }
});

// ✅ POST
app.post('/news', authenticate, upload.single('image'), async (req, res) => {
  try {
    const { title_ar, body_ar, title_en, body_en, published } = req.body;
    if (!title_ar || !body_ar)
      return res.status(400).json({ success: false, message: 'العنوان العربي والمحتوى العربي مطلوبان' });
    if (!req.file)
      return res.status(400).json({ success: false, message: 'صورة الخبر مطلوبة' });
    const imageUrl = req.file.path; // ✅ Cloudinary URL
    const news = await new News({
      title_ar, body_ar,
      title_en: title_en || '', body_en: body_en || '',
      title: title_ar, body: body_ar,
      imageUrl, published: published !== 'false',
    }).save();
    await updateNewsJson();
    res.status(201).json({ success: true, message: 'تم إضافة الخبر بنجاح', data: news });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'حدث خطأ أثناء إضافة الخبر' });
  }
});

// ✅ PATCH
app.patch('/news/:id', authenticate, upload.single('image'), async (req, res) => {
  try {
    const { title_ar, body_ar, title_en, body_en, published } = req.body;
    const update = {};
    if (title_ar)              { update.title_ar = title_ar; update.title = title_ar; }
    if (body_ar)               { update.body_ar  = body_ar;  update.body  = body_ar; }
    if (title_en !== undefined)  update.title_en = title_en;
    if (body_en  !== undefined)  update.body_en  = body_en;
    if (published !== undefined) update.published = published !== 'false';
    if (req.file) {
      update.imageUrl = req.file.path; // ✅ Cloudinary URL
      // ✅ امسح الصورة القديمة من Cloudinary
      const old = await News.findById(req.params.id);
      if (old?.imageUrl) {
        const publicId = getPublicId(old.imageUrl);
        if (publicId) await cloudinary.uploader.destroy(publicId);
      }
    }
    const news = await News.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!news) return res.status(404).json({ success: false, message: 'الخبر غير موجود' });
    await updateNewsJson();
    res.json({ success: true, data: news });
  } catch { res.status(500).json({ success: false, message: 'Server error' }); }
});

// ✅ DELETE
app.delete('/news/:id', authenticate, async (req, res) => {
  try {
    const news = await News.findByIdAndDelete(req.params.id);
    if (!news) return res.status(404).json({ success: false, message: 'الخبر غير موجود' });
    // ✅ امسح الصورة من Cloudinary
    if (news.imageUrl) {
      const publicId = getPublicId(news.imageUrl);
      if (publicId) await cloudinary.uploader.destroy(publicId);
    }
    await updateNewsJson();
    res.json({ success: true, message: 'تم حذف الخبر' });
  } catch { res.status(500).json({ success: false, message: 'Server error' }); }
});

// ──────────────────────────────────────────────
//  CONTACT routes
// ──────────────────────────────────────────────
app.post('/contact', formLimiter, uploadAttachment.single('attachment'), async (req, res) => {
  try {
    const { firstName, lastName, phone, email, details } = req.body;
    if (!firstName || !lastName || !phone || !email || !details)
      return res.status(400).json({ success: false, message: 'جميع الحقول مطلوبة' });
    const attachmentUrl = req.file ? req.file.path : ''; // ✅ Cloudinary URL
    const inquiry = await new Inquiry({ firstName, lastName, phone, email, details, attachmentUrl }).save();
    const attachLine = attachmentUrl
      ? `<tr><td style="color:#888;">المرفق</td><td><a href="${attachmentUrl}">تحميل الملف</a></td></tr>`
      : '';
    await resend.emails.send({
      from: 'نظام الاستفسارات <onboarding@resend.dev>', to: process.env.OFFICE_EMAIL, replyTo: email,
      subject: 'استفسار جديد وصل للمكتب',
      html: `<div dir="rtl" style="font-family:Arial;max-width:600px;margin:auto;border:1px solid #c8a96e;border-radius:8px;overflow:hidden;">
               <div style="background:#2b2b2b;padding:20px;text-align:center;"><h2 style="color:#c8a96e;margin:0;">استفسار جديد</h2></div>
               <div style="padding:24px;background:#fff;">
                 <table width="100%" cellpadding="8">
                   <tr><td style="color:#888;">الاسم</td><td><strong>${firstName} ${lastName}</strong></td></tr>
                   <tr><td style="color:#888;">الهاتف</td><td>${phone}</td></tr>
                   <tr><td style="color:#888;">الإيميل</td><td>${email}</td></tr>
                   <tr><td style="color:#888;vertical-align:top;">التفاصيل</td><td>${details}</td></tr>
                   ${attachLine}
                 </table>
               </div>
             </div>`,
    });
    res.status(201).json({ success: true, message: 'تم إرسال استفسارك بنجاح، سنتواصل معك قريباً', data: inquiry });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'حدث خطأ، يرجى المحاولة مرة أخرى' });
  }
});

app.get('/contact', authenticate, async (req, res) => {
  try {
    const data = await Inquiry.find().sort({ createdAt: -1 });
    res.json({ success: true, count: data.length, data });
  } catch { res.status(500).json({ success: false, message: 'Server error' }); }
});

// ──────────────────────────────────────────────
//  FAQ routes
// ──────────────────────────────────────────────
app.post('/faq', formLimiter, uploadAttachment.single('attachment'), async (req, res) => {
  try {
    const { fullName, email, question } = req.body;
    if (!fullName || !email || !question)
      return res.status(400).json({ success: false, message: 'جميع الحقول مطلوبة' });
    const attachmentUrl = req.file ? req.file.path : ''; // ✅ Cloudinary URL
    const faqQuestion = await new FaqQuestion({ fullName, email, question, attachmentUrl }).save();
    const attachLine = attachmentUrl
      ? `<p><a href="${attachmentUrl}" style="background:#c8a96e;color:#fff;padding:8px 16px;border-radius:6px;text-decoration:none;">📎 تحميل المرفق</a></p>`
      : '';
    await resend.emails.send({
      from: 'نظام الأسئلة الشائعة <onboarding@resend.dev>', to: process.env.OFFICE_EMAIL, replyTo: email,
      subject: 'سؤال جديد من صفحة الأسئلة الشائعة',
      html: `<div dir="rtl" style="font-family:Arial;max-width:600px;margin:auto;border:1px solid #c8a96e;border-radius:8px;overflow:hidden;">
               <div style="background:#2b2b2b;padding:20px;text-align:center;"><h2 style="color:#c8a96e;margin:0;">سؤال جديد</h2></div>
               <div style="padding:24px;background:#fff;">
                 <p><strong>${fullName}</strong> — <a href="mailto:${email}">${email}</a></p>
                 <p style="background:#f9f9f9;padding:12px;border-right:3px solid #c8a96e;">${question}</p>
                 ${attachLine}
               </div>
               <div style="background:#2b2b2b;padding:14px;text-align:center;">
                 <a href="mailto:${email}?subject=رد على سؤالك" style="background:#c8a96e;color:#fff;padding:10px 24px;border-radius:6px;text-decoration:none;">الرد على العميل</a>
               </div>
             </div>`,
    });
    res.status(201).json({ success: true, message: 'تم إرسال سؤالك بنجاح', data: faqQuestion });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'حدث خطأ، يرجى المحاولة مرة أخرى' });
  }
});

app.get('/faq', authenticate, async (req, res) => {
  try {
    const { status } = req.query;
    const data = await FaqQuestion.find(status ? { status } : {}).sort({ createdAt: -1 });
    res.json({ success: true, count: data.length, data });
  } catch { res.status(500).json({ success: false, message: 'Server error' }); }
});

app.patch('/faq/:id/status', authenticate, async (req, res) => {
  try {
    const { status } = req.body;
    if (!['pending', 'answered'].includes(status))
      return res.status(400).json({ success: false, message: 'status غير صحيح' });
    const q = await FaqQuestion.findByIdAndUpdate(req.params.id, { status }, { new: true });
    if (!q) return res.status(404).json({ success: false, message: 'السؤال غير موجود' });
    res.json({ success: true, data: q });
  } catch { res.status(500).json({ success: false, message: 'Server error' }); }
});

// ──────────────────────────────────────────────
//  JOIN routes
// ──────────────────────────────────────────────
app.post('/join', formLimiter, uploadCV.single('cv'), async (req, res) => {
  try {
    const { firstName, lastName, phone, email, details, country } = req.body;
    if (!firstName || !lastName || !phone || !email || !details)
      return res.status(400).json({ success: false, message: 'جميع الحقول مطلوبة' });
    if (!req.file)
      return res.status(400).json({ success: false, message: 'يرجى رفع السيرة الذاتية' });
const cvUrl = req.file.path; 
    const application = await new JoinApplication({ firstName, lastName, phone, email, details, country, cvUrl }).save();
    await resend.emails.send({
      from: 'نظام الانضمام <onboarding@resend.dev>', to: process.env.OFFICE_EMAIL, replyTo: email,
      subject: 'طلب انضمام جديد',
      html: `<div dir="rtl" style="font-family:Arial;max-width:600px;margin:auto;border:1px solid #c8a96e;border-radius:8px;overflow:hidden;">
               <div style="background:#2b2b2b;padding:20px;text-align:center;"><h2 style="color:#c8a96e;margin:0;">طلب انضمام جديد</h2></div>
               <div style="padding:24px;background:#fff;">
                 <table width="100%" cellpadding="8">
                   <tr><td style="color:#888;">الاسم</td><td><strong>${firstName} ${lastName}</strong></td></tr>
                   <tr><td style="color:#888;">البلد</td><td>${country || '-'}</td></tr>
                   <tr><td style="color:#888;">الهاتف</td><td>${phone}</td></tr>
                   <tr><td style="color:#888;">الإيميل</td><td>${email}</td></tr>
                   <tr><td style="color:#888;vertical-align:top;">التفاصيل</td><td>${details}</td></tr>
                   <tr><td style="color:#888;">السيرة الذاتية</td><td><a href="${cvUrl}">تحميل CV</a></td></tr>
                 </table>
               </div>
             </div>`,
    });
    res.status(201).json({ success: true, message: 'تم إرسال طلبك بنجاح، سنتواصل معك قريباً', data: application });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'حدث خطأ، يرجى المحاولة مرة أخرى' });
  }
});

app.get('/join', authenticate, async (req, res) => {
  try {
    const data = await JoinApplication.find().sort({ createdAt: -1 });
    res.json({ success: true, count: data.length, data });
  } catch { res.status(500).json({ success: false, message: 'Server error' }); }
});


// ──────────────────────────────────────────────
//  Keep Alive — يمنع السيرفر من النوم على Render
// ──────────────────────────────────────────────
const SELF_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`;

function keepAlive() {
  setInterval(async () => {
    try {
      const res = await fetch(`${SELF_URL}/ping`);
      console.log(`✅ Keep-alive ping — ${new Date().toISOString()}`);
    } catch (err) {
      console.error('❌ Keep-alive failed:', err.message);
    }
  }, 10 * 60 * 1000); // كل 10 دقايق
}

app.get('/ping', (req, res) => res.json({ success: true, message: 'pong 🏓' }));


// ──────────────────────────────────────────────
//  Start server
// ──────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  keepAlive(); // ✅
});