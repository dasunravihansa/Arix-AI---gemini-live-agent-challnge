// // Injects a flag into any webpage indicating that the Arix Chrome Extension is installed
// // Since run_at is document_start, this runs very early during page load.

document.documentElement.setAttribute("data-arix-extension-installed", "true");

// Listen for messages from the Next.js frontend requesting a screen capture
window.addEventListener("message", (event) => {
    // Only accept messages from same origin (or specific origins if needed)
    if (event.source !== window || !event.data || event.data.type !== "ARIX_CAPTURE_SCREEN") {
        return;
    }

    // Pass the request to the extension's background script
    chrome.runtime.sendMessage({ type: "CAPTURE_SCREEN" }, (response) => {
        // Send the result back to the Next.js app
        if (response && response.dataUrl) {
           window.postMessage({ type: "ARIX_SCREEN_CAPTURED", dataUrl: response.dataUrl }, "*");
        }
    });
});
