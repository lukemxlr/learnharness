function randomId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === "function") c.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  let hex = "";
  for (let i = 0; i < 16; i++) hex += bytes[i]!.toString(16).padStart(2, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A tucked text-only control, matching the native quiz's Why button. */
export function mountDisclosure(container: HTMLElement, kind: "test-output" | "model-solution", label: string, signal: AbortSignal, render: (body: HTMLElement) => void | (() => void)): () => void {
  const document = container.ownerDocument;
  const root = document.createElement("div");
  root.className = `lh-coding-disclosure lh-coding-${kind}`;
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.setAttribute("aria-expanded", "false");
  const body = document.createElement("div");
  body.className = "lh-coding-disclosure__body";
  body.id = `lh-coding-${randomId()}`;
  button.setAttribute("aria-controls", body.id);
  root.append(button);
  container.append(root);
  let open = false, disposed = false;
  let contentCleanup: void | (() => void);
  const close = () => {
    open = false;
    button.textContent = label;
    button.setAttribute("aria-expanded", "false");
    const cleanup = contentCleanup;
    contentCleanup = undefined;
    try { cleanup?.(); }
    finally { body.replaceChildren(); body.remove(); }
  };
  const toggle = () => {
    if (disposed || signal.aborted) return;
    if (open) { close(); return; }
    open = true;
    button.textContent = `Hide ${label.toLowerCase()}`;
    button.setAttribute("aria-expanded", "true");
    root.append(body);
    try {
      const cleanup = render(body);
      // A widget can synchronously abort its owning mount while rendering.
      if (disposed || !open) cleanup?.();
      else contentCleanup = cleanup;
    } catch (error) { close(); throw error; }
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    signal.removeEventListener("abort", dispose);
    button.removeEventListener("click", toggle);
    try { close(); }
    finally { root.remove(); }
  };
  button.addEventListener("click", toggle);
  if (signal.aborted) dispose();
  else signal.addEventListener("abort", dispose, { once: true });
  return dispose;
}
