// Собирает разделы index.html (Форматы, События, Отзывы, Контакты) из content/*.json.
// Контент правится в админке /admin (Sveltia CMS), сборку запускает GitHub Action
// при каждом коммите; локально: `node tools/build.mjs`.
//
// В index.html эти разделы стоят между маркерами <!-- cms:имя --> … <!-- /cms:имя -->
// и целиком перезаписываются — их вёрстку меняем здесь, в шаблонах ниже.
// Телефон, Instagram и текст сообщения WhatsApp подставляются по всей странице и в story.html.
//
// Видео «Историй»: если ролик тяжелее PREVIEW_MIN, ffmpeg делает лёгкое превью
// images/auto/<имя>.mp4 (9 с, без звука); обложка — images/auto/<имя>.jpg.
// Без ffmpeg этот шаг пропускается, карточка играет сам ролик.

import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, join, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const AUTO = 'images/auto';
const PREVIEW_MIN = 3 * 1024 * 1024;   // ролики легче этого играют в карточке как есть
const FULL_MAX = 15 * 1024 * 1024;     // ролики тяжелее этого пережимаются для просмотра целиком

const read = p => readFileSync(join(ROOT, p), 'utf8');
const json = name => JSON.parse(read(`content/${name}.json`));
const formats = json('formats'), events = json('events'), reviews = json('reviews'), contacts = json('contacts');

/* ---------- текст ---------- */
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const attr = s => esc(s).replace(/"/g, '&quot;').replace(/\*/g, '');

// Типограф: неразрывный пробел после коротких слов и перед тире,
// *слова в звёздочках* — каллиграфией, **жирный**, перенос строки — <br>.
function t(s) {
  let x = String(s ?? '').trim().replace(/[ \t]+/g, ' ');
  x = x.replace(/(?<=^|[\s («"„])([\p{L}]{1,2}) (?=[\p{L}\d«"(])/gu, '$1 ');
  x = x.replace(/ (—|–)/g, ' $1');
  x = esc(x)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<span class="script">$1</span>')
    .replace(/\n+/g, '<br>');
  return x.replace(/ /g, '&nbsp;');
}
const paras = s => String(s ?? '').split(/\n\s*\n/).filter(p => p.trim()).map(p => `<p>${t(p)}</p>`).join('\n        ');

/* ---------- медиа ---------- */
const src = p => encodeURI(String(p ?? '').replace(/^\/+/, ''));
const FOCUS = { top: '50% 15%', upper: '50% 38%', bottom: '50% 85%' };
const focus = f => FOCUS[f] ? ` style="object-position:${FOCUS[f]}"` : '';
const img = (o, extra = '') => `<img src="${src(o.photo)}" alt="${attr(o.alt)}" loading="lazy"${focus(o.focus)}${extra}>`;

const ffmpegOk = spawnSync('ffmpeg', ['-version']).status === 0;
if (!ffmpegOk) console.warn('ffmpeg недоступен — превью и обложки для новых видео не создаются');

const manifestPath = join(ROOT, AUTO, 'manifest.json');
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {};
const sha = file => createHash('sha1').update(readFileSync(file)).digest('hex');
const ff = args => {
  const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', ...args]);
  if (r.status !== 0) console.warn('ffmpeg:', String(r.stderr).trim());
  return r.status === 0;
};

// Возвращает пути для карточки: превью-цикл, обложка, ролик для просмотра целиком.
function videoAssets(video) {
  const rel = String(video).replace(/^\/+/, '');
  const file = join(ROOT, rel);
  const name = basename(rel, extname(rel));
  const out = { preview: rel, poster: '', full: rel };
  if (!existsSync(file)) { console.warn('нет файла видео:', rel); return out; }

  const size = statSync(file).size;
  // MOV/HEVC с iPhone не играет в Chrome — такие ролики всегда перекодируем в H.264.
  const codec = ffmpegOk ? String(spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', file]).stdout).trim() : 'h264';
  const foreign = codec !== 'h264' || !/\.mp4$/i.test(rel);
  const want = {
    preview: foreign || size > PREVIEW_MIN || existsSync(join(ROOT, AUTO, `${name}.mp4`)) ? `${AUTO}/${name}.mp4` : null,
    poster: `${AUTO}/${name}.jpg`,
    full: foreign || size > FULL_MAX ? `${AUTO}/${name}.full.mp4` : null,
  };
  // Файл с тем же именем заменили — старые превью уже не подходят.
  const hash = sha(file);
  const stale = manifest[name] && manifest[name] !== hash;

  if (ffmpegOk) {
    mkdirSync(join(ROOT, AUTO), { recursive: true });
    const need = p => p && (stale || !existsSync(join(ROOT, p)));
    let made = false;
    if (need(want.preview)) made = ff(['-ss', '0', '-t', '9', '-i', file, '-an',
      '-vf', 'scale=540:-2', '-c:v', 'libx264', '-crf', '26', '-preset', 'slow',
      '-pix_fmt', 'yuv420p', '-movflags', '+faststart', join(ROOT, want.preview)]) || made;
    if (need(want.full)) made = ff(['-i', file, '-vf', "scale='min(1080,iw)':-2",
      '-c:v', 'libx264', '-crf', '24', '-preset', 'slow', '-c:a', 'aac', '-b:a', '128k',
      '-pix_fmt', 'yuv420p', '-movflags', '+faststart', join(ROOT, want.full)]) || made;
    if (need(want.poster)) made = ff(['-ss', '0.5', '-i', file, '-frames:v', '1',
      '-vf', 'scale=720:-2', '-q:v', '3', join(ROOT, want.poster)]) || made;
    if (made || !manifest[name]) manifest[name] = hash;
  }
  for (const k of ['preview', 'poster', 'full'])
    if (want[k] && existsSync(join(ROOT, want[k]))) out[k] = want[k];
  return out;
}

/* ---------- WhatsApp ---------- */
let digits = String(contacts.phone).replace(/\D/g, '');
if (digits.length === 11 && digits[0] === '8') digits = '7' + digits.slice(1);
const phoneText = digits.length === 11 && digits[0] === '7'
  ? `+7 ${digits.slice(1, 4)} ${digits.slice(4, 7)}-${digits.slice(7, 9)}-${digits.slice(9)}`
  : String(contacts.phone).trim();
const wa = `https://wa.me/${digits}`;
const waLink = (msg, cls, inner) =>
  `<a class="${cls}" data-wa${msg ? `="${attr(msg)}"` : ''} href="${wa}" target="_blank" rel="noopener">${inner}</a>`;
const ARR = '<svg class="arr" aria-hidden="true"><use href="#i-arr"/></svg>';
const WA_ICON = '<svg class="wa" aria-hidden="true"><use href="#i-wa"/></svg>';
const PLAY = '<svg viewBox="0 0 24 24"><path d="M7 4.5v15l12.5-7.5z" fill="currentColor"/></svg>';
const insta = String(contacts.instagram).trim().replace(/^@/, '').replace(/^https?:\/\/(www\.)?instagram\.com\//, '').replace(/\/.*$/, '');
const pad = i => String(i + 1).padStart(2, '0');

/* ---------- шаблоны разделов ---------- */
const S = {};

S.formats = () => {
  const cards = formats.cards ?? [];
  return `<section class="formats" id="formats">
  <div class="formats-top grain" data-theme="dark">
    <div class="wrap">
      <div class="sec-head reveal">
        <div>
          ${formats.eyebrow ? `<p class="label eyebrow">${t(formats.eyebrow)}</p>\n          ` : ''}<h2>${t(formats.title)}</h2>
          ${formats.intro ? `<p class="sub">${t(formats.intro)}</p>` : ''}
        </div>
      </div>
    </div>
  </div>

  <div class="formats-body" data-theme="light">
  <div class="wrap">
    <div class="cards reveal-group" style="--n:${cards.length > 0 && cards.length <= 4 ? cards.length : 3}">
${cards.map((c, i) => `      <article class="card">
        <div class="card-img">${img(c)}</div>
        <div class="card-body">
          <span class="label card-num">${pad(i)}</span>
          <h3>${t(c.title)}</h3>
          <p>${t(c.text)}</p>
          ${waLink(c.message, 'link-arrow', `Обсудить${ARR}`)}
        </div>
      </article>`).join('\n')}
    </div>

    <div class="strip reveal">
      <h3>${t(formats.strip || 'Расскажите о вашем поводе')}</h3>
      <span class="rule" aria-hidden="true"></span>
      ${waLink('', 'btn btn-dark', `Обсудить формат${ARR}`)}
    </div>
  </div>
  </div>
</section>`;
};

S.events = () => {
  const gallery = (events.gallery ?? []).slice(0, 4);
  const reels = events.reels ?? [];
  const cases = events.cases ?? [];
  const reel = r => {
    const v = videoAssets(r.video);
    const media = `<video src="${src(v.preview)}"${v.poster ? ` poster="${src(v.poster)}"` : ''} autoplay muted loop playsinline preload="none" aria-hidden="true"></video>`;
    const cap = `<span class="reel-cap">${r.label ? `<span class="label">${t(r.label)}</span>` : ''}<b>${t(r.title)}</b></span>`;
    return r.open_full === false
      ? `<li><div class="reel">${media}${cap}</div></li>`
      : `<li><button class="reel" type="button" data-full="${src(v.full)}" aria-label="Смотреть видео: ${attr(r.title)}">${media}${cap}<span class="reel-play" aria-hidden="true">${PLAY}</span></button></li>`;
  };
  return `<section class="events sec" id="events" data-theme="light">
  <div class="wrap">
    <div class="sec-head reveal">
      <div>
        <h2>${t(events.title)}</h2>
        ${events.intro ? `<p class="sub">${t(events.intro)}</p>` : ''}
      </div>
    </div>

    <div class="gallery reveal-group" id="gallery">
${gallery.map(g => `      <figure class="shot"><div class="frame">${img(g)}</div>${g.caption ? `<figcaption>${t(g.caption)}</figcaption>` : ''}</figure>`).join('\n')}
    </div>
${reels.length ? `
    <div class="reels reveal" id="reels">
      <div class="reels-head">
        <p class="label eyebrow">${t(events.reels_title || 'Истории в движении')}</p>
        ${events.reels_intro ? `<p class="sub">${t(events.reels_intro)}</p>` : ''}
      </div>
      <ul class="reels-row">
${reels.map(r => '      ' + reel(r)).join('\n')}
      </ul>
    </div>
` : ''}
${cases.map(c => `    <article class="case reveal">
      <div class="case-img">${img(c)}</div>
      <div class="case-body">
        ${c.label ? `<span class="label">${t(c.label)}</span>` : ''}
        <h3>${t(c.title)}</h3>
        ${paras(c.text)}
        ${waLink(c.message, 'link-arrow', `${t(c.button || 'Хочу свою историю')}${ARR}`)}
      </div>
    </article>`).join('\n')}
  </div>
</section>`;
};

S.reviews = () => {
  const [lead, ...rest] = reviews.items ?? [];
  const quote = r => t(r.text).replace(/^«|»$/g, '');
  return `<section class="reviews sec" id="reviews" data-theme="light">
  <div class="wrap">
    <div class="sec-head reveal"><div><h2>${t(reviews.title)}</h2></div></div>
${lead ? `    <figure class="review-lead reveal">
      <blockquote>«${quote(lead)}»</blockquote>
      <figcaption class="label">${t(lead.name)}</figcaption>
    </figure>` : ''}
${rest.length ? `    <div class="review-grid reveal-group">
${rest.map(r => `      <figure class="review"><blockquote>${quote(r)}</blockquote><figcaption class="label">${t(r.name)}</figcaption></figure>`).join('\n')}
    </div>` : ''}
  </div>
</section>`;
};

S.contact = () => `<section class="contact grain" id="contact" data-theme="dark">
  <div class="contact-text reveal">
    <h2>${t(contacts.title)}</h2>
    ${contacts.text ? `<p class="sub">${t(contacts.text)}</p>` : ''}
    ${waLink('', 'btn', `\n      ${WA_ICON}Написать в WhatsApp${ARR}\n    `)}
    <p class="preview" id="waPreview">${esc(contacts.message)}</p>
    <a class="contact-phone" data-wa href="${wa}" target="_blank" rel="noopener" aria-label="Написать в WhatsApp: ${attr(phoneText)}">
      <span class="label">WhatsApp</span>
      <span class="num-line">${esc(phoneText)}</span>
    </a>
    <div class="contact-meta">
      <span class="label">Москва</span>
      ${insta ? `<a class="label" href="https://instagram.com/${insta}" target="_blank" rel="noopener">Instagram</a>` : ''}
    </div>
  </div>
  <div class="contact-img wipe">${img(contacts)}</div>
</section>`;

/* ---------- сборка ---------- */
// Контакты, которые встречаются по всей странице (шапка, меню, кнопки, скрипт).
const contactsEverywhere = html => html
  .replace(/https:\/\/wa\.me\/\d+/g, wa)
  .replace(/const WA_PHONE = '\d*';/, `const WA_PHONE = '${digits}';`)
  .replace(/const WA_TEXT  = '.*?';/, `const WA_TEXT  = '${String(contacts.message).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}';`)
  .replace(/(id="waPreview">)[^<]*/, `$1${esc(contacts.message)}`)
  .replace(/\+7 \d{3} \d{3}-\d{2}-\d{2}/g, phoneText)
  .replace(/https:\/\/instagram\.com\/[\w.]+/g, `https://instagram.com/${insta}`);

function build(page, sections) {
  let html = read(page);
  for (const name of sections) {
    const re = new RegExp(`(<!-- cms:${name} -->\\n)[\\s\\S]*?(\\n<!-- /cms:${name} -->)`);
    if (!re.test(html)) throw new Error(`${page}: нет маркеров <!-- cms:${name} -->`);
    html = html.replace(re, (_, a, b) => a + S[name]() + b);
  }
  html = contactsEverywhere(html);
  if (html !== read(page)) { writeFileSync(join(ROOT, page), html); console.log('обновлён', page); }
}

build('index.html', ['formats', 'events', 'reviews', 'contact']);
build('story.html', []);
if (Object.keys(manifest).length) {
  mkdirSync(join(ROOT, AUTO), { recursive: true });
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
}
