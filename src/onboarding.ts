import { element, initTheme, send } from "./client";
import { errorMessage } from "./shared";

initTheme();

const status = document.createElement("p");
status.className = "warning";
status.hidden = true;
element("done").parentElement?.after(status);
function showError(error: unknown) { status.textContent = errorMessage(error); status.hidden = false; }

element("setup").addEventListener("click", () => { void send("setup").catch(showError); });
// A plain tab rather than a Meet link with a code: GMRec has nothing to join, and landing on
// the user's own meeting list is what they actually need next.
element("meet").addEventListener("click", () => { void chrome.tabs.create({ url: "https://meet.google.com/" }).catch(showError); });
element("done").addEventListener("click", () => { window.close(); });
