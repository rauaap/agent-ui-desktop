/** Immutable original bytes, explicitly cached; never use an unauthenticated img URL. */
import { httpBase, requireToken, authBlocked, tokenFetch, rejectToken } from './auth.js';

export const imagePath = (id) => `/images/${encodeURIComponent(id)}`;
export const imageUrl = (id) => httpBase + imagePath(id);
const CACHE = 'agent-ui.images.v1';
const MAX_BYTES = 100 * 1024 * 1024;
const MAX_ENTRIES = 100;
let writes = Promise.resolve();

async function checked(path, options) {
  const token = requireToken();
  const response = await tokenFetch(path, token, options);
  if (response.status === 401) rejectToken(token);
  if (!response.ok) {
    let message = `Image request failed (${response.status})`;
    try { message = (await response.json()).detail || message; } catch { /* binary/error */ }
    throw new Error(message);
  }
  requireToken();
  return response;
}

/** Cache failures are nonfatal. Serialize writes/eviction, including concurrent uploads. */
export function seedImage(image, blob) {
  const work = async () => {
    if (!globalThis.caches) return;
    const cache = await caches.open(CACHE);
    const url = imageUrl(image.id);
    await cache.delete(url);
    await cache.put(url, new Response(blob, { headers: {
      'Content-Type': image.mime_type, 'Content-Length': String(blob.size),
    } }));
    const keys = await cache.keys();
    let bytes = 0;
    const sizes = [];
    for (const key of keys) {
      const response = await cache.match(key);
      const size = Number(response.headers.get('Content-Length')) || (await response.blob()).size;
      sizes.push(size);
      bytes += size;
    }
    let count = keys.length;
    for (let i = 0; i < keys.length && (count > MAX_ENTRIES || bytes > MAX_BYTES); i++) {
      await cache.delete(keys[i]);
      bytes -= sizes[i]; count--;
    }
  };
  writes = writes.then(work).catch(() => {});
  return writes;
}

export async function uploadImage(file) {
  if (!['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(file.type)) {
    throw new Error('Choose a JPEG, PNG, GIF or WebP image');
  }
  if (file.size > 10 * 1024 * 1024) throw new Error('Image exceeds 10 MiB');
  const response = await checked('/images', {
    method: 'POST', headers: { 'Content-Type': file.type }, body: file,
  });
  const image = await response.json();
  await seedImage(image, file);
  return image;
}

export async function loadImage(image) {
  requireToken(); // A cache hit must not bypass the application's authentication gate.
  await writes;
  let response;
  try { response = await (await caches.open(CACHE)).match(imageUrl(image.id)); } catch { /* unavailable */ }
  if (!response) {
    response = await checked(imagePath(image.id));
    const blob = await response.blob();
    await seedImage(image, blob);
    requireToken();
    return blob;
  }
  const blob = await response.blob();
  requireToken();
  return blob;
}

/** Each reserved box owns its URL. Disposing a subtree also ignores late loads. */
export class ImageViews {
  constructor(onLoad = () => {}) { this.items = new Map(); this.onLoad = onLoad; }
  append(parent, images = []) {
    if (!images.length) return;
    const strip = document.createElement('div');
    strip.className = 'image-strip';
    parent.append(strip);
    for (const image of images) {
      const box = document.createElement('div');
      box.className = 'image-box';
      box.textContent = 'Loading image…';
      box.style.aspectRatio = `${image.width || 1} / ${image.height || 1}`;
      strip.append(box);
      const item = { url: null };
      this.items.set(box, item);
      loadImage(image).then((blob) => {
        if (!this.items.has(box) || authBlocked()) return;
        item.url = URL.createObjectURL(blob);
        const img = document.createElement('img');
        img.alt = 'Attached image';
        img.src = item.url;
        img.onerror = () => { box.textContent = 'Image could not be displayed'; };
        box.replaceChildren(img);
        this.onLoad();
      }).catch((error) => {
        if (this.items.has(box)) box.textContent = error.message;
      });
    }
  }
  dispose(root = null) {
    for (const [box, item] of this.items) {
      if (root && !root.contains(box)) continue;
      if (item.url) URL.revokeObjectURL(item.url);
      this.items.delete(box);
    }
  }
}
