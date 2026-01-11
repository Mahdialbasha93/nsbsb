// Global Variables
let isCloning = false;
let reconnectAttempts = 0;
let totalOperations = 0;
let successfulOperations = 0;
let startTime = null;
let slowDetectionInterval = null;
let lastActivityTime = Date.now();
let autoScroll = true;
let logTypes = {
    'info': true,
    'success': true,
    'warning': true,
    'error': true,
    'system': true
};

// Stats object
const stats = {
    roles: 0,
    channels: 0,
    emojis: 0,
    reconnects: 0,
    errors: 0,
    speed: 0
};

// DOM Elements
const dom = {
    startBtn: null,
    statusDot: null,
    statusText: null,
    tokenInput: null,
    logContainer: null,
    scrollIcon: null
};

// Initialize on page load
document.addEventListener('DOMContentLoaded', function() {
    // Cache DOM elements
    dom.startBtn = document.getElementById('startBtn');
    dom.statusDot = document.getElementById('statusDot');
    dom.statusText = document.getElementById('statusText');
    dom.tokenInput = document.getElementById('token');
    dom.logContainer = document.getElementById('logContainer');
    dom.scrollIcon = document.getElementById('scrollIcon');
    
    // Load saved data
    loadSavedData();
    
    // Add initial log
    addLog('System initialized and ready. Enter your Discord credentials to start cloning.', 'system');
    
    // Update refresh time
    updateRefreshTime();
    
    // Add keyboard shortcuts
    setupKeyboardShortcuts();
});

// Load saved data from localStorage
function loadSavedData() {
    const savedToken = localStorage.getItem('discord_token');
    const savedSourceId = localStorage.getItem('source_guild_id');
    const savedTargetId = localStorage.getItem('target_guild_id');
    const savedAutoReconnect = localStorage.getItem('auto_reconnect');
    const savedSkipEmojis = localStorage.getItem('skip_emojis');
    const savedReconnectAttempts = localStorage.getItem('reconnect_attempts');
    const savedSlowThreshold = localStorage.getItem('slow_threshold');
    
    if (savedToken) document.getElementById('token').value = savedToken;
    if (savedSourceId) document.getElementById('sourceGuildId').value = savedSourceId;
    if (savedTargetId) document.getElementById('targetGuildId').value = savedTargetId;
    if (savedAutoReconnect) document.getElementById('autoReconnect').checked = savedAutoReconnect === 'true';
    if (savedSkipEmojis) document.getElementById('skipEmojis').checked = savedSkipEmojis === 'true';
    if (savedReconnectAttempts) {
        document.getElementById('reconnectAttempts').value = savedReconnectAttempts;
        document.getElementById('reconnectValue').textContent = savedReconnectAttempts;
    }
    if (savedSlowThreshold) {
        document.getElementById('slowThreshold').value = savedSlowThreshold;
        document.getElementById('slowThresholdValue').textContent = savedSlowThreshold;
    }
}

// Save data to localStorage
function saveData() {
    const token = document.getElementById('token').value;
    const sourceId = document.getElementById('sourceGuildId').value;
    const targetId = document.getElementById('targetGuildId').value;
    const autoReconnect = document.getElementById('autoReconnect').checked;
    const skipEmojis = document.getElementById('skipEmojis').checked;
    const reconnectAttempts = document.getElementById('reconnectAttempts').value;
    const slowThreshold = document.getElementById('slowThreshold').value;
    
    if (token) localStorage.setItem('discord_token', token);
    if (sourceId) localStorage.setItem('source_guild_id', sourceId);
    if (targetId) localStorage.setItem('target_guild_id', targetId);
    localStorage.setItem('auto_reconnect', autoReconnect);
    localStorage.setItem('skip_emojis', skipEmojis);
    localStorage.setItem('reconnect_attempts', reconnectAttempts);
    localStorage.setItem('slow_threshold', slowThreshold);
    
    showToast('Settings saved successfully!', 'success');
}

// Update range value display
function updateReconnectValue(value) {
    document.getElementById('reconnectValue').textContent = value;
}

function updateSlowThresholdValue(value) {
    document.getElementById('slowThresholdValue').textContent = value;
}

// Toggle token visibility
function toggleTokenVisibility() {
    const tokenInput = document.getElementById('token');
    const eyeIcon = tokenInput.nextElementSibling.querySelector('i');
    
    if (tokenInput.type === 'password') {
        tokenInput.type = 'text';
        eyeIcon.className = 'fas fa-eye-slash';
    } else {
        tokenInput.type = 'password';
        eyeIcon.className = 'fas fa-eye';
    }
}

// Toggle advanced settings
function toggleAdvancedSettings() {
    const settings = document.getElementById('advancedSettings');
    const arrow = document.getElementById('settingsArrow');
    const header = document.querySelector('.settings-header');
    
    settings.classList.toggle('show');
    header.classList.toggle('active');
}

// Add log entry
function addLog(message, type = 'info') {
    const logContainer = document.getElementById('logContainer');
    const logEntry = document.createElement('div');
    const timestamp = new Date().toLocaleTimeString();
    
    logEntry.className = `log-entry log-${type} show`;
    logEntry.innerHTML = `
        <span class="log-time">[${timestamp}]</span>
        <span class="log-content">${message}</span>
    `;
    
    logContainer.appendChild(logEntry);
    
    // Auto-scroll if enabled
    if (autoScroll) {
        logContainer.scrollTop = logContainer.scrollHeight;
    }
    
    // Update log count and size
    updateLogInfo();
    
    // Show toast for important messages
    if (type === 'error' || type === 'success') {
        showToast(message, type);
    }
    
    // Update activity time for slow detection
    updateActivity();
}

// Update log information
function updateLogInfo() {
    const logEntries = document.querySelectorAll('.log-entry');
    const logCount = document.getElementById('logCount');
    const logSize = document.getElementById('logSize');
    
    const count = logEntries.length;
    const size = (document.getElementById('logContainer').textContent.length / 1024).toFixed(2);
    
    logCount.textContent = `${count} log ${count === 1 ? 'entry' : 'entries'}`;
    logSize.textContent = `${size} KB`;
}

// Toggle auto-scroll
function toggleAutoScroll() {
    autoScroll = !autoScroll;
    const icon = document.getElementById('scrollIcon');
    
    if (autoScroll) {
        icon.className = 'fas fa-arrow-down';
        showToast('Auto-scroll enabled', 'info');
    } else {
        icon.className = 'fas fa-pause';
        showToast('Auto-scroll disabled', 'info');
    }
}

// Toggle log type filter
function toggleLogType(type) {
    logTypes[type] = !logTypes[type];
    const logEntries = document.querySelectorAll(`.log-${type}`);
    
    logEntries.forEach(entry => {
        if (logTypes[type]) {
            entry.classList.add('show');
        } else {
            entry.classList.remove('show');
        }
    });
}

// Filter logs
function filterLogs() {
    showToast('Use the filter badges above to show/hide log types', 'info');
}

// Export logs
function exportLogs() {
    const logs = document.getElementById('logContainer').textContent;
    const blob = new Blob([logs], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    
    a.href = url;
    a.download = `discord-cloner-logs-${new Date().toISOString().split('T')[0]}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    
    showToast('Logs exported successfully!', 'success');
}

// Clear logs
function clearLogs() {
    if (confirm('Are you sure you want to clear all logs?')) {
        document.getElementById('logContainer').innerHTML = '';
        addLog('Logs cleared by user', 'system');
        updateLogInfo();
        showToast('Logs cleared', 'success');
    }
}

// Show toast notification
function showToast(message, type = 'info') {
    const toast = document.getElementById('toast');
    
    toast.textContent = message;
    toast.className = `toast ${type} show`;
    
    setTimeout(() => {
        toast.classList.remove('show');
    }, 3000);
}

// Update status
function updateStatus(status, isActive = false) {
    const statusIndicator = document.getElementById('statusIndicator');
    const statusDot = document.getElementById('statusDot');
    const statusText = document.getElementById('statusText');
    
    statusText.textContent = status;
    
    if (isActive) {
        statusIndicator.classList.add('active');
        statusDot.classList.add('active');
    } else {
        statusIndicator.classList.remove('active');
        statusDot.classList.remove('active');
    }
}

// Update statistics
function updateStat(stat, value) {
    stats[stat] = value;
    const element = document.getElementById(`${stat}Stat`);
    
    if (element) {
        element.textContent = value;
        
        // Add animation
        element.style.transform = 'scale(1.2)';
        setTimeout(() => {
            element.style.transform = 'scale(1)';
        }, 300);
    }
}

// Update speed stat
function updateSpeedStat() {
    if (startTime) {
        const elapsedMinutes = (Date.now() - startTime) / 60000;
        if (elapsedMinutes > 0) {
            const speed = Math.round(totalOperations / elapsedMinutes);
            updateStat('speed', speed);
        }
    }
}

// Update refresh time
function updateRefreshTime() {
    const refreshTime = document.getElementById('refreshTime');
    const now = new Date();
    refreshTime.textContent = `Last update: ${now.toLocaleTimeString()}`;
}

// Update activity timestamp
function updateActivity() {
    lastActivityTime = Date.now();
}

// Check for slow operation
function isSlow() {
    const slowThreshold = parseInt(document.getElementById('slowThreshold').value) * 1000;
    const timeSinceLastActivity = Date.now() - lastActivityTime;
    return timeSinceLastActivity > slowThreshold;
}

// Start slow detection
function startSlowDetection() {
    if (slowDetectionInterval) clearInterval(slowDetectionInterval);
    
    slowDetectionInterval = setInterval(() => {
        if (isCloning && isSlow() && document.getElementById('autoReconnect').checked) {
            reconnect();
        }
    }, 5000); // Check every 5 seconds
}

// Stop slow detection
function stopSlowDetection() {
    if (slowDetectionInterval) {
        clearInterval(slowDetectionInterval);
        slowDetectionInterval = null;
    }
}

// Reconnect function
function reconnect() {
    const maxAttempts = parseInt(document.getElementById('reconnectAttempts').value);
    
    if (reconnectAttempts >= maxAttempts) {
        addLog('Maximum reconnect attempts reached. Stopping.', 'error');
        stopCloning();
        return;
    }
    
    reconnectAttempts++;
    updateStat('reconnects', reconnectAttempts);
    
    addLog(`Slow operation detected. Reconnecting... (Attempt ${reconnectAttempts}/${maxAttempts})`, 'warning');
    
    // Simulate reconnection
    setTimeout(() => {
        updateActivity();
        addLog('Reconnected successfully! Resuming operations...', 'success');
    }, 2000);
}

// Start cloning process
async function startCloning() {
    const token = document.getElementById('token').value.trim();
    const sourceGuildId = document.getElementById('sourceGuildId').value.trim();
    const targetGuildId = document.getElementById('targetGuildId').value.trim();
    const autoReconnect = document.getElementById('autoReconnect').checked;
    const skipEmojis = document.getElementById('skipEmojis').checked;
    
    // Validation
    if (!token || token === 'TOKEN_HERE' || !token.startsWith('')) {
        showToast('Please enter a valid Discord token', 'error');
        return;
    }
    
    if (!sourceGuildId || !targetGuildId) {
        showToast('Please enter both source and target server IDs', 'error');
        return;
    }
    
    if (sourceGuildId === targetGuildId) {
        showToast('Source and target server cannot be the same', 'error');
        return;
    }
    
    if (isCloning) {
        stopCloning();
        return;
    }
    
    // Save data
    saveData();
    
    // Reset stats
    stats.roles = 0;
    stats.channels = 0;
    stats.emojis = 0;
    stats.reconnects = 0;
    stats.errors = 0;
    stats.speed = 0;
    totalOperations = 0;
    successfulOperations = 0;
    reconnectAttempts = 0;
    startTime = Date.now();
    
    // Update UI
    updateStat('roles', 0);
    updateStat('channels', 0);
    updateStat('emojis', 0);
    updateStat('reconnects', 0);
    updateStat('errors', 0);
    updateStat('speed', 0);
    
    const startBtn = document.getElementById('startBtn');
    startBtn.innerHTML = '<i class="fas fa-stop"></i> STOP CLONING';
    startBtn.classList.remove('btn-success');
    startBtn.classList.add('btn-danger');
    
    isCloning = true;
    updateStatus('Starting cloning process...', true);
    
    // Start slow detection
    if (autoReconnect) {
        startSlowDetection();
    }
    
    // Clear logs and add starting message
    document.getElementById('logContainer').innerHTML = '';
    addLog('🚀 Starting Discord server cloning process...', 'system');
    addLog(`Source Server ID: ${sourceGuildId}`, 'info');
    addLog(`Target Server ID: ${targetGuildId}`, 'info');
    addLog(`Auto-reconnect: ${autoReconnect ? 'Enabled' : 'Disabled'}`, 'info');
    addLog(`Skip emojis: ${skipEmojis ? 'Yes' : 'No'}`, 'info');
    
    showToast('Cloning process started!', 'success');
    
    // Start the cloning simulation
    simulateCloningProcess(token, sourceGuildId, targetGuildId, skipEmojis);
}

// Stop cloning process
function stopCloning() {
    if (!confirm('Are you sure you want to stop the cloning process?')) {
        return;
    }
    
    isCloning = false;
    
    // Update UI
    const startBtn = document.getElementById('startBtn');
    startBtn.innerHTML = '<i class="fas fa-play"></i> START CLONING';
    startBtn.classList.remove('btn-danger');
    startBtn.classList.add('btn-success');
    
    updateStatus('Cloning stopped by user');
    addLog('🛑 Cloning process stopped by user', 'warning');
    
    // Stop slow detection
    stopSlowDetection();
    
    showToast('Cloning stopped', 'warning');
    
    // Calculate final statistics
    const successRate = totalOperations > 0 ? Math.round((successfulOperations / totalOperations) * 100) : 0;
    addLog(`📊 Final Statistics: ${successfulOperations}/${totalOperations} successful (${successRate}%)`, 'info');
}

// Simulate cloning process
function simulateCloningProcess(token, sourceGuildId, targetGuildId, skipEmojis) {
    // This simulates the cloning process
    // In a real implementation, this would connect to a backend server
    
    const steps = [
        { name: 'Connecting to Discord API...', duration: 2000, type: 'info', stat: null },
        { name: 'Validating server permissions...', duration: 1500, type: 'info', stat: null },
        { name: 'Deleting existing content in target server...', duration: 3000, type: 'warning', stat: null },
        { name: 'Cloning server roles...', duration: 4000, type: 'success', stat: 'roles', count: 15 },
        { name: 'Cloning categories...', duration: 2500, type: 'success', stat: null },
        { name: 'Cloning text channels...', duration: 5000, type: 'success', stat: 'channels', count: 20 },
        { name: 'Cloning voice channels...', duration: 3500, type: 'success', stat: 'channels', count: 8 },
        ...(skipEmojis ? [] : [
            { name: 'Cloning emojis...', duration: 6000, type: 'success', stat: 'emojis', count: 25 },
        ]),
        { name: 'Updating server settings...', duration: 2000, type: 'info', stat: null },
        { name: 'Finalizing cloning process...', duration: 1500, type: 'system', stat: null }
    ];
    
    let currentStep = 0;
    
    function processNextStep() {
        if (!isCloning || currentStep >= steps.length) {
            if (isCloning) {
                finishCloning();
            }
            return;
        }
        
        const step = steps[currentStep];
        currentStep++;
        
        // Update status
        updateStatus(step.name, true);
        updateActivity();
        
        // Simulate step processing
        setTimeout(() => {
            if (!isCloning) return;
            
            totalOperations++;
            
            // Simulate random success (90% success rate)
            const success = Math.random() > 0.1;
            
            if (success) {
                successfulOperations++;
                
                if (step.type === 'success') {
                    addLog(`✅ ${step.name}`, 'success');
                    
                    // Update statistics if applicable
                    if (step.stat && step.count) {
                        const current = stats[step.stat];
                        const newValue = current + step.count;
                        updateStat(step.stat, newValue);
                    }
                } else {
                    addLog(`📝 ${step.name}`, step.type);
                }
                
                // Update speed
                updateSpeedStat();
                updateRefreshTime();
                
                // Simulate auto-reconnect if slow
                if (document.getElementById('autoReconnect').checked && 
                    Math.random() < 0.2 && // 20% chance to simulate slow operation
                    reconnectAttempts < parseInt(document.getElementById('reconnectAttempts').value)) {
                    
                    addLog('⚡ Simulating slow operation...', 'warning');
                    setTimeout(() => {
                        if (isCloning) {
                            reconnect();
                            setTimeout(() => processNextStep(), 1000);
                        }
                    }, 3000);
                    return;
                }
                
                processNextStep();
            } else {
                // Simulate error
                stats.errors++;
                updateStat('errors', stats.errors);
                
                addLog(`❌ Failed: ${step.name}`, 'error');
                
                // Retry logic
                if (stats.errors < 3) {
                    addLog('🔄 Retrying step...', 'warning');
                    currentStep--; // Retry same step
                    setTimeout(() => processNextStep(), 2000);
                } else {
                    addLog('❌ Too many errors. Stopping process.', 'error');
                    stopCloning();
                }
            }
        }, step.duration);
    }
    
    processNextStep();
}

// Finish cloning
function finishCloning() {
    isCloning = false;
    
    // Update UI
    const startBtn = document.getElementById('startBtn');
    startBtn.innerHTML = '<i class="fas fa-play"></i> START CLONING';
    startBtn.classList.remove('btn-danger');
    startBtn.classList.add('btn-success');
    
    updateStatus('Cloning completed successfully!');
    addLog('🎉 Server cloning completed successfully!', 'success');
    
    // Stop slow detection
    stopSlowDetection();
    
    // Calculate final speed
    const elapsedMinutes = (Date.now() - startTime) / 60000;
    const speed = Math.round(totalOperations / elapsedMinutes);
    updateStat('speed', speed);
    
    showToast('Cloning completed successfully!', 'success');
    
    // Play success sound (if enabled by browser)
    try {
        const audio = new Audio('data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAZGF0YQQAAAAAAA==');
        audio.volume = 0.3;
        audio.play();
    } catch (e) {
        // Audio not supported
    }
}

// Show help modal
function showHelp() {
    document.getElementById('helpModal').classList.add('show');
}

// Close help modal
function closeHelp() {
    document.getElementById('helpModal').classList.remove('show');
}

// Setup keyboard shortcuts
function setupKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
        // Ctrl + Enter: Start/Stop cloning
        if (e.ctrlKey && e.key === 'Enter') {
            e.preventDefault();
            startCloning();
        }
        
        // Ctrl + L: Clear logs
        if (e.ctrlKey && e.key === 'l') {
            e.preventDefault();
            clearLogs();
        }
        
        // Ctrl + S: Save settings
        if (e.ctrlKey && e.key === 's') {
            e.preventDefault();
            saveData();
        }
        
        // Escape: Close modal if open
        if (e.key === 'Escape') {
            closeHelp();
        }
    });
    
    // Add shortcut hint
    addLog('💡 Tip: Use Ctrl+Enter to start/stop cloning, Ctrl+L to clear logs, Ctrl+S to save settings', 'info');
}

// Close modal when clicking outside
window.onclick = function(event) {
    const modal = document.getElementById('helpModal');
    if (event.target === modal) {
        closeHelp();
    }
};

// Auto-save on input change
document.getElementById('token').addEventListener('input', saveData);
document.getElementById('sourceGuildId').addEventListener('input', saveData);
document.getElementById('targetGuildId').addEventListener('input', saveData);
document.getElementById('autoReconnect').addEventListener('change', saveData);
document.getElementById('skipEmojis').addEventListener('change', saveData);
document.getElementById('reconnectAttempts').addEventListener('change', saveData);
document.getElementById('slowThreshold').addEventListener('change', saveData);
