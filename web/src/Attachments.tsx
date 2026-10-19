/**
 * Images attached in the composer: picked, pasted or dropped, fitted to the
 * host's limits in the browser, and shown as a strip of thumbnails until the
 * message is sent.
 */
import { For, Show } from 'solid-js';
import type { UserImageLimits } from '@conhost/web/protocol';
import { imageDamage, sniffImageType } from '@conhost/web/image-bytes';
import { base64Length, fitByRedraw, fitNote, noFitReason } from './fit';

export interface Attachment {
  id: string;
  name: string;
  mediaType: string;
  /** Raw base64, as the host takes it. */
  data: string;
  /** data: URL for the thumbnail and the sent message's own row. */
  dataUrl: string;
  /** What was done to fit it, when it was not sent as picked. */
  adjusted?: 'shrunk' | 'converted';
  /** Says what `adjusted` did, in words for the thumbnail's tooltip. */
  note?: string;
}

let attachmentSeq = 0;

function readDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(blob);
  });
}

async function loadImage(file: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function canvasBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/** Redraw at w×h as WebP, or as JPEG on a white ground where the browser
 *  can't write WebP (Safari hands back PNG instead). Null when the browser
 *  gives no 2D context or no image at this size, as past its canvas limits,
 *  so a smaller size is tried (fitByRedraw). */
async function redraw(img: HTMLImageElement, w: number, h: number): Promise<{ blob: Blob; flattened: boolean } | null> {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, w, h);
  const webp = await canvasBlob(canvas, 'image/webp', 0.9);
  if (webp && webp.type === 'image/webp') return { blob: webp, flattened: false };
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  const jpeg = await canvasBlob(canvas, 'image/jpeg', 0.9);
  return jpeg ? { blob: jpeg, flattened: true } : null;
}

/**
 * Read a file as an attachment that fits `limits`, the host's
 * (`imageLimitsFrom` its welcome). One that already fits is sent byte for
 * byte; one that is too big, too large on a side, or in a format the model
 * APIs don't take (BMP, SVG, …) is redrawn smaller as WebP/JPEG. A PNG, JPEG,
 * GIF or WebP whose structure doesn't hold to its end is refused, not
 * redrawn, as is a PNG with a chunk that fails its checksum (imageDamage):
 * the browser draws what it has of one, and would send that as if it were
 * the picture. Damage inside a JPEG's, GIF's or WebP's compressed data takes
 * a decoder to see, and isn't caught here. Throws with a reason the composer
 * shows.
 */
export async function prepareImage(file: File, limits: UserImageLimits): Promise<Attachment> {
  const L = limits;
  const name = file.name || 'pasted image';
  // The type by the bytes, as the host reads it: a browser takes the type
  // from the file name.
  const bytes = new Uint8Array(await file.arrayBuffer());
  const sniffed = sniffImageType(bytes);
  if (sniffed) {
    const damage = imageDamage(bytes, sniffed);
    if (damage) throw new Error(`${name} ${damage}`);
  }
  let img: HTMLImageElement;
  try {
    img = await loadImage(file);
  } catch {
    throw new Error(`${name} can't be read as an image`);
  }
  const width = img.naturalWidth;
  const height = img.naturalHeight;
  if (!width || !height) throw new Error(`${name} has no size to draw it at`);

  if (sniffed && width <= L.maxSidePx && height <= L.maxSidePx && base64Length(file.size) <= L.maxBase64Chars) {
    const dataUrl = await readDataUrl(file);
    const data = dataUrl.slice(dataUrl.indexOf(',') + 1);
    return {
      id: `att${++attachmentSeq}`,
      name,
      mediaType: sniffed,
      data,
      dataUrl: `data:${sniffed};base64,${data}`,
    };
  }

  const fit = await fitByRedraw(width, height, L, (w, h) => redraw(img, w, h));
  if (!fit.ok) throw new Error(noFitReason(name, fit, L));
  const dataUrl = await readDataUrl(fit.blob);
  return {
    id: `att${++attachmentSeq}`,
    name,
    mediaType: fit.blob.type,
    data: dataUrl.slice(dataUrl.indexOf(',') + 1),
    dataUrl,
    adjusted: fit.w !== width || fit.h !== height ? 'shrunk' : 'converted',
    note: fitNote(fit, { width, height, type: file.type, to: fit.blob.type }),
  };
}

/**
 * The image files a paste carries. A paste that also carries text (copied
 * spreadsheet cells come with a picture of themselves) is a text paste, and
 * yields nothing here.
 */
export function pastedImages(data: DataTransfer | null): File[] {
  if (!data) return [];
  if (data.getData('text/plain').trim()) return [];
  return [...data.files].filter((f) => f.type.startsWith('image/'));
}

/** Whether a drag carries files, so the composer should accept the drop. */
export function dragHasFiles(e: DragEvent): boolean {
  return [...(e.dataTransfer?.types ?? [])].includes('Files');
}

export function AttachmentStrip(props: {
  attachments: Attachment[];
  preparing: number;
  notice: string | null;
  onRemove(id: string): void;
}) {
  return (
    <Show when={props.attachments.length > 0 || props.preparing > 0 || props.notice}>
      <div class="mb-2 flex flex-wrap items-end gap-2">
        <For each={props.attachments}>{(a) => (
          <div class="relative group" title={a.note ? `${a.name} — ${a.note}` : a.name}>
            <img
              src={a.dataUrl}
              alt={a.name}
              class="block h-16 max-w-[8rem] object-contain rounded border border-neutral-800 bg-neutral-900"
            />
            <Show when={a.adjusted}>
              <span class="absolute bottom-0.5 left-0.5 px-1 rounded bg-neutral-950/80 text-[9px] font-mono text-amber-300">{a.adjusted}</span>
            </Show>
            <button
              type="button"
              class="absolute -top-1.5 -right-1.5 w-4 h-4 leading-none rounded-full bg-neutral-800 border border-neutral-600 text-neutral-300 hover:bg-rose-900 hover:text-rose-100 text-[10px]"
              title="remove"
              onClick={() => props.onRemove(a.id)}
            >×</button>
          </div>
        )}</For>
        <Show when={props.preparing > 0}>
          <span class="text-[11px] font-mono text-neutral-500 animate-pulse">reading {props.preparing} image{props.preparing === 1 ? '' : 's'}…</span>
        </Show>
        <Show when={props.notice}>
          <span class="text-[11px] font-mono text-amber-300/90">{props.notice}</span>
        </Show>
      </div>
    </Show>
  );
}
