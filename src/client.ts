import type { Reply } from "./types";

export async function send<T>(type: string, payload: object = {}): Promise<T> {
  const reply: Reply<T> = await chrome.runtime.sendMessage({ target: "background", type, ...payload });
  if (!reply?.ok) throw new Error(reply && !reply.ok ? reply.error : "GMRec did not respond. Reload the extension and Meet tab.");
  return reply.data;
}
export function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing UI element: ${id}`);
  return found as T;
}
export type SelectOption = { value: string; label: string };
export type CustomSelect = { setValue: (value: string) => void; setDisabled: (disabled: boolean) => void };
// A small custom-built dropdown (button + listbox), replacing native <select> so it can be
// styled consistently instead of taking on the OS's own menu chrome.
export function createSelect(container: HTMLElement, options: SelectOption[], value: string, onChange: (value: string) => void): CustomSelect {
  container.replaceChildren();
  container.classList.add("gselect");
  const trigger = document.createElement("button");
  trigger.type = "button"; trigger.className = "gselect-trigger";
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");
  const list = document.createElement("ul");
  list.className = "gselect-list"; list.setAttribute("role", "listbox"); list.hidden = true;
  let current = value;
  let activeIndex = Math.max(0, options.findIndex(option => option.value === current));
  const labelOf = (v: string) => options.find(option => option.value === v)?.label ?? v;
  function renderOptions() {
    trigger.textContent = labelOf(current);
    list.replaceChildren(...options.map((option, index) => {
      const item = document.createElement("li");
      item.textContent = option.label; item.setAttribute("role", "option"); item.tabIndex = -1;
      item.setAttribute("aria-selected", String(option.value === current));
      item.className = "gselect-option" + (index === activeIndex ? " is-active" : "");
      item.addEventListener("mousedown", event => event.preventDefault());
      item.addEventListener("click", () => { try { choose(option.value); } finally { close(); trigger.focus(); } });
      return item;
    }));
  }
  function markActive() { Array.from(list.children).forEach((item, index) => item.classList.toggle("is-active", index === activeIndex)); }
  function onDocClick(event: MouseEvent) { if (!container.contains(event.target as Node)) close(); }
  function open() {
    if (trigger.disabled || !list.hidden) return;
    list.hidden = false; trigger.setAttribute("aria-expanded", "true");
    activeIndex = Math.max(0, options.findIndex(option => option.value === current));
    markActive();
    document.addEventListener("click", onDocClick, true);
  }
  function close() {
    if (list.hidden) return;
    list.hidden = true; trigger.setAttribute("aria-expanded", "false");
    document.removeEventListener("click", onDocClick, true);
  }
  function choose(v: string) { if (v !== current) { current = v; renderOptions(); onChange(v); } }
  trigger.addEventListener("click", () => (list.hidden ? open() : close()));
  trigger.addEventListener("keydown", event => {
    if (!["ArrowDown", "ArrowUp", "Enter", " ", "Escape"].includes(event.key)) return;
    event.preventDefault();
    if (event.key === "Escape") { close(); return; }
    if (event.key === "ArrowDown") { open(); activeIndex = Math.min(options.length - 1, activeIndex + 1); markActive(); return; }
    if (event.key === "ArrowUp") { open(); activeIndex = Math.max(0, activeIndex - 1); markActive(); return; }
    if (list.hidden) open(); else { try { choose(options[activeIndex].value); } finally { close(); } }
  });
  container.append(trigger, list);
  renderOptions();
  return {
    setValue: v => { current = v; renderOptions(); },
    setDisabled: disabled => { trigger.disabled = disabled; if (disabled) close(); },
  };
}
export function initTheme() {
  const button = element<HTMLButtonElement>("themeToggle");
  function apply(theme: string) { document.documentElement.dataset.theme = theme; button.setAttribute("aria-pressed", String(theme === "dark")); button.textContent = theme === "dark" ? "Light theme" : "Dark theme"; }
  // Suppress transitions for the initial paint only, so opening the popup in dark mode does not
  // animate every surface up from the light palette.
  document.documentElement.classList.add("no-transitions");
  apply(localStorage.getItem("gmrec-theme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
  requestAnimationFrame(() => requestAnimationFrame(() => document.documentElement.classList.remove("no-transitions")));
  button.addEventListener("click", () => {
    const theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    apply(theme); localStorage.setItem("gmrec-theme", theme);
  });
}
