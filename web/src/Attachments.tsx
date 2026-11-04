/**
 * Images attached in the composer: picked, pasted or dropped, fitted to the
 * host's limits in the browser, and shown as a strip of thumbnails until the
 * message is sent.
 */
import { For, Show } from 'solid-js';
import type { UserImageLimits } from '@conhost/web/protocol';
import { imageDamage, isAnimated, sniffImageType } from '@conhost/web/image-bytes';
import { ANIMATED_REDRAWN_NOTE, base64Length, fitByRedraw, fitNote, noFitReason } from './fit';

export interface Attachment {
  id: string;
  name: string;
  mediaType: string;
  /** Raw base64, as the host takes it. */
  data: string;
  /** data: URL for the thumbnail and the sent message's own row. */
  dataUrl: string;
  /** What was done to fit it, when it was not sent as picked. */
  adjusted?: 'shrunk' | 'converted' | 'still frame';
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

/** A read of a picked file, which fails when the file changed or went away after it was picked. */
async function readPicked<T>(name: string, read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch {
    throw new Error(`${name} couldn't be read; attach it again`);
  }
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

async function redraw(img: HTMLImageElement, w: number, h: number): Promise<{ blob: Blob; flattened: boolean } | null> {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, w, h);
  // Safari's canvas writes PNG when asked for WebP.
  const webp = await canvasBlob(canvas, 'image/webp', 0.9);
  if (webp && webp.type === 'image/webp') return { blob: webp, flattened: false };
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  const jpeg = await canvasBlob(canvas, 'image/jpeg', 0.9);
  return jpeg ? { blob: jpeg, flattened: true } : null;
}

export async function prepareImage(file: File, limits: UserImageLimits): Promise<Attachment> {
  const L = limits;
  const name = file.name || 'pasted image';
  // The type by the bytes, as the host reads it: a browser takes the type
  // from the file name.
  const bytes = new Uint8Array(await readPicked(name, () => file.arrayBuffer()));
  const sniffed = sniffImageType(bytes);
  // A browser draws what it has of a cut-short or damaged image.
  if (sniffed) {
    const damage = imageDamage(bytes, sniffed);
    if (damage) throw new Error(`${name} ${damage}; attach a whole copy`);
  }
  const animated = sniffed !== undefined && isAnimated(bytes, sniffed);
  let img: HTMLImageElement;
  try {
    img = await loadImage(file);
  } catch {
    throw new Error(sniffed
      ? `${name} can't be drawn by this browser: it may be damaged, or in a form this browser can't decode; attach an intact copy, or convert it to PNG or JPEG`
      : `${name} isn't in a format this browser can read; convert it to PNG or JPEG`);
  }
  const width = img.naturalWidth;
  const height = img.naturalHeight;
  if (!width || !height) throw new Error(`${name} has no size to draw it at`);

  if (sniffed && !animated && width <= L.maxSidePx && height <= L.maxSidePx && base64Length(file.size) <= L.maxBase64Chars) {
    const dataUrl = await readPicked(name, () => readDataUrl(file));
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
    adjusted: animated ? 'still frame' : fit.w !== width || fit.h !== height ? 'shrunk' : 'converted',
    note: animated && fit.w === width && fit.h === height && !fit.flattened && sniffed === fit.blob.type
      ? ANIMATED_REDRAWN_NOTE
      : animated
        ? `${fitNote(fit, { width, height, type: sniffed ?? file.type, to: fit.blob.type })}; ${ANIMATED_REDRAWN_NOTE}`
        : fitNote(fit, { width, height, type: sniffed ?? file.type, to: fit.blob.type }),
  };
}

/**
 * The image files a paste carries. A paste that also carries text (copied
 * spreadsheet cells come with a picture of themselves) is a text paste, and
 * yields nothing here.
 */
/** Whether a file may be an image: its type says so, or the browser didn't
 *  recognise its type, which is then empty, and its bytes decide. */
export const mayBeImage = (f: File): boolean => f.type.startsWith('image/') || f.type === '';

export function pastedImages(data: DataTransfer | null): File[] {
  if (!data) return [];
  if (data.getData('text/plain').trim()) return [];
  return [...data.files].filter(mayBeImage);
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
              {(label) => (
                <span class="absolute bottom-0.5 left-0.5 px-1 rounded bg-neutral-950/80 text-[9px] font-mono text-amber-300">{label()}</span>
              )}
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
