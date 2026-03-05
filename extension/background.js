// Background service worker script for handling core extension logic

const UI_CONTROLLED_PERMISSIONS = ["scripting", "desktopCapture", "notifications", "alarms"];

// Count granted optional permissions and update the extension badge
function updateBadge() {
  chrome.permissions.getAll((result) => {
    let count = 0;
    const grantedPerms = result.permissions || [];

    UI_CONTROLLED_PERMISSIONS.forEach((perm) => {
      if (grantedPerms.includes(perm)) {
        count++;
      }
    });

    if (count > 0) {
      chrome.action.setBadgeText({ text: count.toString() });
      chrome.action.setBadgeBackgroundColor({ color: "#e74c3c" });
    } else {
      chrome.action.setBadgeText({ text: "" });
    }
  });
}

// Triggered when the extension is first installed or updated
chrome.runtime.onInstalled.addListener(() => {
  console.log("Arix Gemini Tutor installed successfully.");
  updateBadge();
});

// Update badge when background service worker starts up
updateBadge();

// Listen for permission changes to refresh badge in real-time
if (chrome.permissions.onAdded) {
  chrome.permissions.onAdded.addListener(updateBadge);
  chrome.permissions.onRemoved.addListener(updateBadge);
}

// Listen for messages from popup.js or content scripts
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {

  // FIX: Removed "capture_screen" handler with `|| true` permission bypass.
  // Now only one handler exists for screen capture, with proper permission check.

  // Handle screen capture request from content.js (injected into Next.js page)
  if (request.type === "CAPTURE_SCREEN") {
    // Verify desktopCapture permission before capturing
    chrome.permissions.contains({ permissions: ["desktopCapture"] }, (hasPermission) => {
      if (hasPermission) {
        chrome.tabs.captureVisibleTab(null, { format: "jpeg", quality: 60 }, (dataUrl) => {
          if (!chrome.runtime.lastError && dataUrl) {
            sendResponse({ dataUrl: dataUrl });
          } else {
            sendResponse({ error: chrome.runtime.lastError?.message || "Failed to capture tab." });
          }
        });
      } else {
        // Prompt user to enable desktopCapture in the extension popup
        sendResponse({
          error: "Screen capture permission not granted. Please enable it in the Arix extension settings."
        });
      }
    });

    // Return true to indicate async response
    return true;
  }

  // Handle capture triggered from the extension popup UI ("capture_screen" action)
  if (request.action === "capture_screen") {
    chrome.permissions.contains({ permissions: ["desktopCapture"] }, (hasPermission) => {
      if (hasPermission) {
        chrome.tabs.captureVisibleTab(null, { format: "png" }, (dataUrl) => {
          if (chrome.runtime.lastError) {
            sendResponse({ error: chrome.runtime.lastError.message });
          } else {
            sendResponse({ img: dataUrl });
          }
        });
      } else {
        sendResponse({ error: "No screen capture permission. Please turn it ON via extension settings." });
      }
    });

    return true;
  }
});