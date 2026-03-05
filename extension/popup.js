// // Helper function to check if a specific permission has been granted
// // Updates the toggle switch state accordingly
function checkPermission(permName, checkboxId) {
    // // Use chrome.permissions API to verify current status
    chrome.permissions.contains({
        permissions: [permName]
    }, (result) => {
        // // Set checkbox to ON if permission exists
        document.getElementById(checkboxId).checked = result;
    });
}

// // Handle user interaction with permission toggle switches
function handlePermissionToggle(permName, checkboxId) {
    const checkbox = document.getElementById(checkboxId);

    // // Listen for state changes on the switch
    checkbox.addEventListener('change', (e) => {
        if (e.target.checked) {
            // // If user turns ON, prompt the browser's permission dialog
            chrome.permissions.request({
                permissions: [permName]
            }, (granted) => {
                // // Revert switch to OFF if user denies the prompt
                if (!granted) {
                    e.target.checked = false;
                }
            });
        } else {
            // // If user turns OFF, programmatically revoke the permission
            chrome.permissions.remove({
                permissions: [permName]
            }, (removed) => {
                // // Revert switch if removal fails for some reason
                if (!removed) {
                    e.target.checked = true;
                }
            });
        }
    });
}

// // Initialize the popup when DOM is fully loaded
document.addEventListener('DOMContentLoaded', () => {
    // // 1. Setup Screen Capture permission listener
    checkPermission('desktopCapture', 'perm-desktopCapture');
    handlePermissionToggle('desktopCapture', 'perm-desktopCapture');

    // // 2. Setup Notifications permission listener
    checkPermission('notifications', 'perm-notifications');
    handlePermissionToggle('notifications', 'perm-notifications');

    // // 3. Setup Alarms permission listener
    checkPermission('alarms', 'perm-alarms');
    handlePermissionToggle('alarms', 'perm-alarms');

    // // 4. Setup Scripting permission listener
    checkPermission('scripting', 'perm-scripting');
    handlePermissionToggle('scripting', 'perm-scripting');
});