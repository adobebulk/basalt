/**
 * Photo Gallery Admin Panel
 * ─────────────────────────
 * Runs locally on your Mac Mini (or any machine).
 * Provides a mobile-friendly web UI to:
 *   - Create / list photo series
 *   - Upload photos into a series
 *   - Publish / unpublish a series
 *   - Trigger a Hugo rebuild
 *
 * Usage:
 *   cd admin && npm install && node server.js
 *
 * Then open http://localhost:3001 in any browser (or via Tailscale).
 */

'use strict';

const path    = require('path');
const fs      = require('fs');
const { execSync, spawn } = require('child_process');

const express = require('express');
const multer  = require('multer');

// ─── Config ────────────────────────────────────────────────────────────────

const PORT         = process.env.ADMIN_PORT   || 3001;
// Paths are relative to this file's location (admin/).
const SITE_ROOT    = path.resolve(__dirname, '..', 'site');
const CONTENT_DIR  = path.join(SITE_ROOT, 'content', 'projects');
const HUGO_DIR     = SITE_ROOT;
const UPLOAD_TMP   = path.join(__dirname, 'uploads');

// ─── Helpers ───────────────────────────────────────────────────────────────

function slugify(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function readFrontMatter(mdPath) {
  try {
    const raw = fs.readFileSync(mdPath, 'utf8');
    const match = raw.match(/^---\n([\s\S]*?)\n---/);
    if (!match) return {};
    const fm = {};
    for (const line of match[1].split('\n')) {
      const [k, ...rest] = line.split(':');
      if (k && rest.length) fm[k.trim()] = rest.join(':').trim().replace(/^"(.*)"$/, '$1');
    }
    return fm;
  } catch { return {}; }
}

function writeFrontMatter(mdPath, fm, body = '') {
  const lines = Object.entries(fm)
    .map(([k, v]) => {
      if (typeof v === 'string') return `${k}: "${v}"`;
      return `${k}: ${v}`;
    })
    .join('\n');
  fs.writeFileSync(mdPath, `---\n${lines}\n---\n${body}`);
}

function listProjects() {
  if (!fs.existsSync(CONTENT_DIR)) return [];
  return fs.readdirSync(CONTENT_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => {
      const slug    = d.name;
      const dir     = path.join(CONTENT_DIR, slug);
      const mdPath  = path.join(dir, 'index.md');
      const fm      = readFrontMatter(mdPath);
      const photos  = listPhotos(slug);
      return {
        slug,
        title:       fm.title   || slug,
        description: fm.description || '',
        date:        fm.date    || '',
        draft:       fm.draft === 'true' || fm.draft === true,
        photoCount:  photos.length,
        cover:       fm.cover   || (photos[0] || ''),
      };
    });
}

function listPhotos(slug) {
  const dir = path.join(CONTENT_DIR, slug);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => /\.(jpe?g|png|webp|gif|avif)$/i.test(f))
    .sort();
}

function hugoRebuild() {
  return new Promise((resolve, reject) => {
    // Also run tailwind first if the binary is available
    const tw = path.resolve(__dirname, '..', 'node_modules', '.bin', 'tailwindcss');
    const twInput  = path.join(SITE_ROOT, 'assets', 'css', 'input.css');
    const twOutput = path.join(SITE_ROOT, 'static', 'css', 'style.css');
    if (fs.existsSync(tw)) {
      try {
        execSync(`"${tw}" -i "${twInput}" -o "${twOutput}" --minify`, { cwd: HUGO_DIR });
      } catch (e) {
        console.warn('Tailwind build warning:', e.message);
      }
    }

    const hugo = spawn('hugo', ['--source', HUGO_DIR, '--minify'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    hugo.stdout.on('data', d => (out += d));
    hugo.stderr.on('data', d => (out += d));
    hugo.on('close', code => {
      if (code === 0) resolve(out);
      else reject(new Error(out || `Hugo exited with code ${code}`));
    });
    hugo.on('error', err => reject(new Error(`Could not start hugo: ${err.message}`)));
  });
}

// ─── Express setup ─────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

fs.mkdirSync(UPLOAD_TMP, { recursive: true });

const upload = multer({
  dest: UPLOAD_TMP,
  limits: { fileSize: 300 * 1024 * 1024 }, // 300 MB per file
  fileFilter(_, file, cb) {
    cb(null, /\.(jpe?g|png|webp|avif)$/i.test(file.originalname));
  },
});

// ─── Serve raw photos for admin preview ────────────────────────────────────
// e.g. GET /photos/iceland-2024/001.jpg → content/projects/iceland-2024/001.jpg
app.use('/photos', express.static(CONTENT_DIR));

// ─── API routes ────────────────────────────────────────────────────────────

// List all projects
app.get('/api/projects', (_, res) => {
  res.json(listProjects());
});

// Create a new project
app.post('/api/projects', (req, res) => {
  const { title, description } = req.body;
  if (!title) return res.status(400).json({ error: 'title required' });

  const slug = slugify(title);
  const dir  = path.join(CONTENT_DIR, slug);
  if (fs.existsSync(dir)) return res.status(409).json({ error: 'project already exists' });

  fs.mkdirSync(dir, { recursive: true });
  writeFrontMatter(path.join(dir, 'index.md'), {
    title,
    description: description || '',
    date: new Date().toISOString().split('T')[0],
    cover: '',
    draft: true,
  });
  res.json({ slug, title, draft: true });
});

// Upload photos to a project
app.post('/api/projects/:slug/photos', upload.array('photos', 100), async (req, res) => {
  const { slug } = req.params;
  const dir = path.join(CONTENT_DIR, slug);
  if (!fs.existsSync(dir)) return res.status(404).json({ error: 'project not found' });

  const saved = [];
  for (const file of (req.files || [])) {
    const ext  = path.extname(file.originalname).toLowerCase() || '.jpg';
    const name = path.basename(file.originalname, path.extname(file.originalname))
      .replace(/[^a-z0-9_-]/gi, '_');
    const dest = path.join(dir, `${name}${ext}`);
    fs.renameSync(file.path, dest);
    saved.push(path.basename(dest));
  }

  // Auto-set cover if none is set yet
  const mdPath = path.join(dir, 'index.md');
  const fm = readFrontMatter(mdPath);
  if (!fm.cover && saved.length > 0) {
    fm.cover = saved[0];
    writeFrontMatter(mdPath, fm);
  }

  res.json({ uploaded: saved });
});

// List photos in a project
app.get('/api/projects/:slug/photos', (req, res) => {
  const { slug } = req.params;
  res.json(listPhotos(slug));
});

// Delete a photo
app.delete('/api/projects/:slug/photos/:photo', (req, res) => {
  const { slug, photo } = req.params;
  const filePath = path.join(CONTENT_DIR, slug, path.basename(photo));
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'photo not found' });
  fs.unlinkSync(filePath);
  res.json({ deleted: photo });
});

// Update project metadata (title, description, cover, draft)
app.patch('/api/projects/:slug', (req, res) => {
  const { slug } = req.params;
  const mdPath = path.join(CONTENT_DIR, slug, 'index.md');
  if (!fs.existsSync(mdPath)) return res.status(404).json({ error: 'project not found' });

  const fm = readFrontMatter(mdPath);
  const { title, description, cover, draft } = req.body;
  if (title       !== undefined) fm.title       = title;
  if (description !== undefined) fm.description = description;
  if (cover       !== undefined) fm.cover       = cover;
  if (draft       !== undefined) fm.draft       = draft;
  writeFrontMatter(mdPath, fm);
  res.json({ ok: true, ...fm });
});

// Publish (set draft: false) or unpublish (draft: true)
app.post('/api/projects/:slug/publish', (req, res) => {
  const { slug } = req.params;
  const mdPath = path.join(CONTENT_DIR, slug, 'index.md');
  if (!fs.existsSync(mdPath)) return res.status(404).json({ error: 'project not found' });

  const fm = readFrontMatter(mdPath);
  fm.draft = req.body.draft === true ? 'true' : 'false';
  writeFrontMatter(mdPath, fm);
  res.json({ slug, draft: fm.draft === 'true' });
});

// Trigger Hugo rebuild
app.post('/api/rebuild', async (_, res) => {
  try {
    const output = await hugoRebuild();
    res.json({ ok: true, output });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Start ─────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n📷  Photo admin running at http://localhost:${PORT}\n`);
});
