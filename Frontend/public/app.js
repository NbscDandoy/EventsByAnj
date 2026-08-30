/* ==========================================
   INITIALIZATION & GLOBAL STATE
   ========================================== */
const socket = io();
let guests = [];

// Persistent state for tracking loaded and selected files
let loadedFiles = JSON.parse(localStorage.getItem('loadedFiles')) || [];
let currentActiveFile = localStorage.getItem('currentActiveFile') || '';

// Global store for occupation totals
let globalOccupationData = [];

// Web Audio API context for audio feedback
let audioCtx = null;

function playSwitchSound(type = 'click') {
    try {
        if (!audioCtx) {
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (audioCtx.state === 'suspended') {
            audioCtx.resume();
        }

        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.connect(gain);
        gain.connect(audioCtx.destination);

        const now = audioCtx.currentTime;

        if (type === 'pull') {
            osc.type = 'triangle';
            osc.frequency.setValueAtTime(120, now);
            osc.frequency.exponentialRampToValueAtTime(40, now + 0.08);
            gain.gain.setValueAtTime(0.3, now);
            gain.gain.exponentialRampToValueAtTime(0.01, now + 0.08);
            osc.start(now);
            osc.stop(now + 0.08);
        } else if (type === 'checkin') {
            osc.type = 'sine';
            osc.frequency.setValueAtTime(523.25, now);
            osc.frequency.setValueAtTime(659.25, now + 0.08);
            gain.gain.setValueAtTime(0.2, now);
            gain.gain.exponentialRampToValueAtTime(0.01, now + 0.25);
            osc.start(now);
            osc.stop(now + 0.25);
        } else {
            osc.type = 'sine';
            osc.frequency.setValueAtTime(300, now);
            osc.frequency.exponentialRampToValueAtTime(80, now + 0.05);
            gain.gain.setValueAtTime(0.25, now);
            gain.gain.exponentialRampToValueAtTime(0.01, now + 0.05);
            osc.start(now);
            osc.stop(now + 0.05);
        }
    } catch (e) {
        console.warn('AudioContext restriction:', e);
    }
}

// DOM Initialization
document.addEventListener('DOMContentLoaded', () => {
    initTheme();
    setupTabNavigation();
    loadGuests();
    setupDragAndDrop();
    restoreUIState();
    setupModalKeybinds();
    setupGlobalControls();
    setupEventDelegation();

    // Kapag binuksan ang URL mula sa QR Code scan (may #seating sa dulo)
    if (window.location.hash === '#seating') {
        switchTab('tables');
    }
});

// Listener kapag nagbago ang URL hash
window.addEventListener('hashchange', () => {
    if (window.location.hash === '#seating') {
        switchTab('tables');
    }
});

/* ==========================================
   SIDEBAR QR CODE GENERATOR
   ========================================== */
function generateSeatingQRCode() {
    const container = document.getElementById('sidebarQrCodeContainer') || document.getElementById('seatingQrCodeContainer');
    if (!container) return;

    container.innerHTML = '';
    
    // Idagdag ang #seating hash tag para sa direct routing
    const seatingURL = `${window.location.origin}${window.location.pathname}#seating`;

    if (typeof QRCode !== 'undefined') {
        new QRCode(container, {
            text: seatingURL,
            width: 128,
            height: 128,
            colorDark: "#000000",
            colorLight: "#ffffff",
            correctLevel: QRCode.CorrectLevel.H
        });
    } else {
        const fallbackImg = document.createElement('img');
        fallbackImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=130x130&data=${encodeURIComponent(seatingURL)}`;
        fallbackImg.alt = 'QR Code';
        fallbackImg.style.width = '128px';
        fallbackImg.style.height = '128px';
        container.appendChild(fallbackImg);
    }
}

/* ==========================================
   THEME / DARK MODE CONTROLS
   ========================================== */
function initTheme() {
    const themeToggle = document.getElementById('btnThemeToggle');
    const savedTheme = localStorage.getItem('theme');
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const defaultDark = savedTheme ? savedTheme === 'dark' : prefersDark;

    document.documentElement.setAttribute('data-theme', defaultDark ? 'dark' : 'light');
    if (themeToggle) themeToggle.checked = defaultDark;

    if (themeToggle) {
        themeToggle.addEventListener('change', (e) => {
            playSwitchSound('pull');
            const isDark = e.target.checked;
            document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
            localStorage.setItem('theme', isDark ? 'dark' : 'light');
        });
    }
}

/* ==========================================
   VIEW / TAB NAVIGATION CONTROLS
   ========================================== */
function setupTabNavigation() {
    const btnNavDashboard = document.getElementById('btnNavDashboard');
    const btnNavTables = document.getElementById('btnNavTables');

    if (btnNavDashboard) btnNavDashboard.addEventListener('click', () => switchTab('dashboard'));
    if (btnNavTables) btnNavTables.addEventListener('click', () => switchTab('tables'));
}

function switchTab(tab) {
    const mainDashboardView = document.getElementById('mainDashboardView');
    const mainTablesView = document.getElementById('mainTablesView');
    const btnNavDashboard = document.getElementById('btnNavDashboard');
    const btnNavTables = document.getElementById('btnNavTables');
    const mainTitle = document.getElementById('mainTitle');
    const sidebarQrSection = document.getElementById('sidebarQrSection');

    if (tab === 'dashboard') {
        if (mainDashboardView) mainDashboardView.style.display = 'block';
        if (mainTablesView) mainTablesView.style.display = 'none';
        if (btnNavDashboard) btnNavDashboard.classList.add('active');
        if (btnNavTables) btnNavTables.classList.remove('active');
        if (mainTitle) mainTitle.textContent = 'Dashboard';

        // Itatago ang Sidebar QR code kapag nasa Dashboard view
        if (sidebarQrSection) sidebarQrSection.style.display = 'none';
    } else if (tab === 'tables') {
        if (mainDashboardView) mainDashboardView.style.display = 'none';
        if (mainTablesView) mainTablesView.style.display = 'block';
        if (btnNavDashboard) btnNavDashboard.classList.remove('active');
        if (btnNavTables) btnNavTables.classList.add('active');
        if (mainTitle) mainTitle.textContent = 'Seating Capacity Overview';
        
        // Kung nasa URL hash `#seating` (view mode ng bisita/mag-i-iscan), itago rin ang QR code sa sidebar
        if (sidebarQrSection) {
            sidebarQrSection.style.display = window.location.hash === '#seating' ? 'none' : 'block';
        }
        
        loadTableOccupation();
        generateSeatingQRCode();
    }
}

/* ==========================================
   SIDEBAR, ACTIVE BANNER & FILE STATE
   ========================================== */
function restoreUIState() {
    fetchRecentFiles();
    renderDashboardActiveBanner();
}

function renderUIState() {
    renderRecentFilesSidebar();
    renderDashboardActiveBanner();
}

function setupDragAndDrop() {
    const dropZone = document.getElementById('drop-zone') || document.getElementById('dropZone');
    const fileInput = document.getElementById('excelFile') || document.getElementById('fileInput');

    if (!dropZone || !fileInput) return;

    fileInput.setAttribute('multiple', 'multiple');

    dropZone.addEventListener('click', (e) => {
        if (!e.target.closest('.btn-remove-chip') && !e.target.closest('.btn-load-file') && e.target.tagName !== 'LABEL') {
            fileInput.click();
        }
    });

    ['dragenter', 'dragover'].forEach(eventName => {
        dropZone.addEventListener(eventName, (e) => {
            e.preventDefault();
            e.stopPropagation();
            dropZone.classList.add('drop-zone--over', 'dragover');
        }, false);
    });

    ['dragleave', 'drop'].forEach(eventName => {
        dropZone.addEventListener(eventName, (e) => {
            e.preventDefault();
            e.stopPropagation();
            dropZone.classList.remove('drop-zone--over', 'dragover');
        }, false);
    });

    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const files = Array.from(e.dataTransfer.files);
        if (files.length) {
            processSelectedFiles(files);
        }
    });

    fileInput.addEventListener('change', () => {
        const files = Array.from(fileInput.files);
        if (files.length) {
            processSelectedFiles(files);
        }
    });
}

async function processSelectedFiles(files) {
    await uploadExcelFiles(files);
    await fetchRecentFiles();
}

function saveStateToLocalStorage() {
    localStorage.setItem('loadedFiles', JSON.stringify(loadedFiles));
    localStorage.setItem('currentActiveFile', currentActiveFile);
}

async function fetchRecentFiles() {
    try {
        const res = await fetch('/api/recent-files');
        if (!res.ok) return;
        const data = await res.json();
        
        const serverFiles = data.files || [];
        localStorage.setItem('recentUploadedFiles', JSON.stringify(serverFiles.map(name => ({ name }))));
        
        loadedFiles = loadedFiles.filter(f => serverFiles.includes(f));
        if (serverFiles.length > 0 && (!currentActiveFile || !serverFiles.includes(currentActiveFile))) {
            currentActiveFile = serverFiles[0];
        } else if (serverFiles.length === 0) {
            currentActiveFile = '';
            loadedFiles = [];
        }
        
        saveStateToLocalStorage();
        renderUIState();
    } catch (err) {
        console.error('Error fetching recent files from server:', err);
    }
}

function getRecentFiles() {
    try {
        const data = localStorage.getItem('recentUploadedFiles');
        return data ? JSON.parse(data) : [];
    } catch (e) {
        console.error('Error reading recent files:', e);
        return [];
    }
}

function renderRecentFilesSidebar() {
    const container = document.getElementById('recentFilesContainer') || document.getElementById('recent-files-list');
    if (!container) return;

    const recentFiles = getRecentFiles();

    if (recentFiles.length === 0) {
        container.innerHTML = `<span class="empty-state" style="font-size:0.8rem; opacity:0.6;">No recent files</span>`;
        return;
    }

    container.innerHTML = recentFiles.map(file => {
        const fileName = file.name || file;
        const isCurrent = fileName === currentActiveFile;
        const buttonText = isCurrent ? 'Active' : 'Load';
        const buttonClass = isCurrent ? 'btn-success' : 'btn-primary';
        const disabledAttr = isCurrent ? 'disabled' : '';
        const escapedName = escapeHtml(fileName);

        return `
            <div class="recent-file-item ${isCurrent ? 'active' : ''}" style="display: flex; align-items: center; justify-content: space-between; gap: 6px; padding: 6px 8px; margin-bottom: 6px; background: var(--card-bg, rgba(255,255,255,0.05)); border-radius: 6px;">
                <span class="recent-file-name" title="${escapedName}" style="flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 0.8rem;">
                    📄 ${escapedName}
                </span>
                <div style="display: flex; align-items: center; gap: 4px; flex-shrink: 0;">
                    <button class="btn-load-file btn ${buttonClass}" style="padding: 2px 8px; font-size: 0.72rem; border-radius: 4px; font-weight: 600;" ${disabledAttr} data-file-name="${escapedName}">${buttonText}</button>
                    <button class="btn-remove-chip btn-delete-file" data-file-name="${escapedName}" title="Remove file" style="border:none; background:transparent; cursor:pointer; color:#ef4444; font-weight:bold; font-size: 1rem; padding: 0 2px; line-height: 1;">&times;</button>
                </div>
            </div>
        `;
    }).join('');
}

/* ==========================================
   LOAD & REMOVE FILE FUNCTIONS
   ========================================== */
async function selectAndLoadFile(fileName) {
    if (!fileName) return;

    currentActiveFile = fileName;
    
    if (!loadedFiles.includes(fileName)) {
        loadedFiles.push(fileName);
    }

    saveStateToLocalStorage();
    renderUIState();

    try {
        const response = await fetch(`/api/load-file?name=${encodeURIComponent(fileName)}`, { 
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fileName })
        });

        if (!response.ok) {
            console.error('Failed to switch file on backend database');
        }
    } catch (err) {
        console.error('Error connecting to backend during file switch:', err);
    } finally {
        await loadGuests();
        await fetchRecentFiles();
    }
}

async function removeRecentFile(e, fileName) {
    if (e) e.stopPropagation();

    if (!confirm(`Are you sure you want to delete "${fileName}"? This will clear all guest records from the database.`)) {
        return;
    }

    try {
        const res = await fetch(`/api/recent-files/${encodeURIComponent(fileName)}`, { 
            method: 'DELETE' 
        });

        if (!res.ok) {
            console.error('Failed to delete file from backend server');
        }
    } catch (err) {
        console.error('Error syncing file removal with backend server:', err);
    } finally {
        // Alisin sa array ng loadedFiles
        loadedFiles = loadedFiles.filter(f => f !== fileName);
        
        // SURIN KUNG ANG BINURANG FILE AY ANG KASALUKUYANG ACTIVE FILE
        if (currentActiveFile === fileName) {
            // Piliin ang pinakahuling natirang file (kung mayroon)
            const remainingFile = loadedFiles.length > 0 ? loadedFiles[loadedFiles.length - 1] : '';
            currentActiveFile = remainingFile;

            // KUNG MAY NATIRANG FILE,I-LOAD AT I-SYNC ITO SA BACKEND AGAD
            if (remainingFile) {
                await selectAndLoadFile(remainingFile);
            } else {
                // KUNG WALA NANG NATIRANG FILE, LINISIN ANG STATE
                saveStateToLocalStorage();
                await fetchRecentFiles();
                await loadGuests();
            }
        } else {
            // Kung hindi naman active file ang binura, simpleng refresh lang ng state
            saveStateToLocalStorage();
            await fetchRecentFiles();
            await loadGuests();
        }
    }
}

function renderDashboardActiveBanner() {
    let totalGuestsCount = guests.length;
    let totalCheckedInCount = guests.filter(g => g.status === 'Checked-In').length;

    const overallPercentage = totalGuestsCount > 0 
        ? Math.round((totalCheckedInCount / totalGuestsCount) * 100) 
        : 0;

    const overallPctEl = document.getElementById('overallAttendancePct');
    const checkedInCountEl = document.getElementById('checkedInCount');
    const totalGuestsCountEl = document.getElementById('totalGuestsCount');

    if (overallPctEl) overallPctEl.textContent = `${overallPercentage}%`;
    if (checkedInCountEl) checkedInCountEl.textContent = totalCheckedInCount;
    if (totalGuestsCountEl) totalGuestsCountEl.textContent = totalGuestsCount;

    const container = document.getElementById('activeFilesContainer') || document.getElementById('dashboardActiveFileBanner');
    if (!container) return;

    if (!currentActiveFile && loadedFiles.length === 0) {
        container.innerHTML = '';
        return;
    }

    const activeTitle = currentActiveFile || loadedFiles[0] || '';

    const chipsHTML = loadedFiles.map(name => {
        const escapedName = escapeHtml(name);

        return `
            <span class="file-chip" style="display:inline-flex; align-items:center; gap:6px; background:var(--primary-color, #2563eb); color:#ffffff; padding:4px 10px; border-radius:14px; font-size:0.8rem; font-weight:500;">
                📄 ${escapedName}
                <button type="button" class="btn-remove-chip" data-file-name="${escapedName}" title="Remove File" style="border:none; background:none; color:#ffffff; cursor:pointer; font-weight:bold; font-size:0.9rem; line-height:1; padding:0;">&times;</button>
            </span>
        `;
    }).join(' ');

    container.innerHTML = `
        <div class="active-file-container" style="padding: 12px 16px; border-radius: 10px; margin-bottom: 16px; display: flex; flex-direction: column; gap: 8px; background: var(--card-bg, #ffffff); border: 1px solid var(--border-color, #e2e8f0); color: var(--text-color, #1e293b); transition: background-color 0.3s ease, color 0.3s ease;">
            <div style="font-size: 0.9rem; font-weight: 500;">
                You are selecting: <span style="font-weight: 700; text-decoration: underline;">${escapeHtml(activeTitle)}</span>
            </div>
            <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
                <span style="font-size: 0.82rem; opacity: 0.8;">Active File(s):</span>
                ${chipsHTML}
            </div>
        </div>
    `;
}

function clearSelectedChip(event, fileName) {
    if (event) event.stopPropagation();
    removeRecentFile(null, fileName);
}

async function uploadExcelFiles(files) {
    let successCount = 0;

    for (const file of files) {
        const formData = new FormData();
        formData.append('file', file);

        try {
            const res = await fetch('/api/import', { method: 'POST', body: formData });
            if (res.ok) {
                const data = await res.json();
                if (data.activeFile) {
                    currentActiveFile = data.activeFile;
                    if (!loadedFiles.includes(data.activeFile)) {
                        loadedFiles.push(data.activeFile);
                    }
                }
                successCount++;
            } else {
                const errData = await res.json().catch(() => ({}));
                console.error(`Failed to process ${file.name}:`, errData.error);
            }
        } catch (err) {
            console.error(`Error uploading ${file.name}:`, err);
        }
    }

    const fileInput = document.getElementById('excelFile') || document.getElementById('fileInput');
    if (fileInput) fileInput.value = '';

    if (successCount > 0) {
        saveStateToLocalStorage();
        await loadGuests();
    } else {
        alert('Failed to process the uploaded file(s).');
    }
}

/* ==========================================
   GLOBAL CONTROLS & EVENT DELEGATION
   ========================================== */
function setupGlobalControls() {
    const btnAddGuest = document.getElementById('btnAddGuest');
    const btnSaveExcel = document.getElementById('btnSaveExcel');
    const btnSaveDocs = document.getElementById('btnSaveDocs');
    const searchInput = document.getElementById('search');
    const filterCategory = document.getElementById('filterCategory');
    const filterTable = document.getElementById('filterTable');
    const sortBySelect = document.getElementById('sortBy');
    const editForm = document.getElementById('editGuestForm');

    const btnCloseEditModal = document.getElementById('btnCloseEditModal');
    const btnCancelEdit = document.getElementById('btnCancelEdit');
    const btnCloseTableModal = document.getElementById('btnCloseTableModal');
    const btnDismissTableModal = document.getElementById('btnDismissTableModal');

    const btnToggleSidebar = document.getElementById('btnToggleSidebar') || document.getElementById('btnMobileSidebarToggle');
    const sidebarOverlay = document.getElementById('sidebarOverlay');

    if (btnAddGuest) btnAddGuest.addEventListener('click', openAddGuestModal);
    if (btnSaveExcel) btnSaveExcel.addEventListener('click', exportExcel);
    if (btnSaveDocs) btnSaveDocs.addEventListener('click', exportDocs);

    if (searchInput) {
        let debounceTimer;
        searchInput.addEventListener('input', () => {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(applyFilters, 200);
        });
    }

    if (filterCategory) filterCategory.addEventListener('change', applyFilters);
    if (filterTable) filterTable.addEventListener('change', applyFilters);
    if (sortBySelect) sortBySelect.addEventListener('change', applyFilters);

    if (editForm) editForm.addEventListener('submit', saveGuestEdit);

    if (btnCloseEditModal) btnCloseEditModal.addEventListener('click', closeEditModal);
    if (btnCancelEdit) btnCancelEdit.addEventListener('click', closeEditModal);
    if (btnCloseTableModal) btnCloseTableModal.addEventListener('click', closeTableModal);
    if (btnDismissTableModal) btnDismissTableModal.addEventListener('click', closeTableModal);

    if (btnToggleSidebar) btnToggleSidebar.addEventListener('click', toggleMobileSidebar);
    if (sidebarOverlay) sidebarOverlay.addEventListener('click', closeMobileSidebar);
}

function toggleMobileSidebar() {
    const sidebar = document.querySelector('.sidebar');
    const overlay = document.getElementById('sidebarOverlay');

    if (sidebar) sidebar.classList.toggle('mobile-active');
    if (overlay) overlay.classList.toggle('active');
}

function closeMobileSidebar() {
    const sidebar = document.querySelector('.sidebar');
    const overlay = document.getElementById('sidebarOverlay');

    if (sidebar) sidebar.classList.remove('mobile-active');
    if (overlay) overlay.classList.remove('active');
}

function setupEventDelegation() {
    const guestTable = document.getElementById('guestTable');
    if (guestTable) {
        guestTable.addEventListener('click', (e) => {
            const target = e.target.closest('button');
            if (!target) return;

            const row = target.closest('tr');
            if (!row) return;

            const guestId = row.dataset.id;
            if (!guestId) return;

            if (target.classList.contains('btn-checkin')) {
                playSwitchSound('checkin');
                checkIn(guestId);
            }
            if (target.classList.contains('btn-undo')) uncheckIn(guestId);
            if (target.classList.contains('btn-edit')) editGuest(guestId);
            if (target.classList.contains('btn-delete')) deleteGuest(guestId);
        });
    }

    const handleOccupationClick = (containerId, isDashboardView) => {
        const container = document.getElementById(containerId);
        if (container) {
            container.addEventListener('click', (e) => {
                const card = e.target.closest('.table-occupation-card') || e.target.closest('.table-card-item');
                if (card && card.dataset.tableName) {
                    const tableName = card.dataset.tableName;
                    if (isDashboardView) {
                        const filterTable = document.getElementById('filterTable');
                        if (filterTable) {
                            filterTable.value = tableName;
                            applyFilters();
                            filterTable.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        }
                    } else {
                        openTableModal(tableName);
                    }
                }
            });
        }
    };

    handleOccupationClick('mainOccupationGrid', true);
    handleOccupationClick('standaloneOccupationGrid', false);

    const recentFilesContainer = document.getElementById('recentFilesContainer') || document.getElementById('recent-files-list');
    if (recentFilesContainer) {
        recentFilesContainer.addEventListener('click', async (e) => {
            const loadBtn = e.target.closest('.btn-load-file');
            const removeBtn = e.target.closest('.btn-remove-chip') || e.target.closest('.btn-delete-file');

            if (loadBtn && loadBtn.dataset.fileName) {
                await selectAndLoadFile(loadBtn.dataset.fileName);
            } else if (removeBtn && removeBtn.dataset.fileName) {
                await removeRecentFile(e, removeBtn.dataset.fileName);
            }
        });
    }

    const activeFilesContainer = document.getElementById('activeFilesContainer') || document.getElementById('dashboardActiveFileBanner');
    if (activeFilesContainer) {
        activeFilesContainer.addEventListener('click', (e) => {
            const removeBtn = e.target.closest('.btn-remove-chip');
            if (removeBtn && removeBtn.dataset.fileName) {
                clearSelectedChip(e, removeBtn.dataset.fileName);
            }
        });
    }
}

/* ==========================================
   DATA LOADING & OCCUPATION LOGIC
   ========================================== */
async function loadGuests() {
    try {
        const response = await fetch('/api/guests');
        if (!response.ok) throw new Error(`HTTP Error: ${response.status}`);
        const data = await response.json();

        guests = (data.guests || data || []);

        populateTableDropdown();
        applyFilters();
        loadTableOccupation();
    } catch (error) {
        console.error('Failed to load guest list:', error);
    }
}

async function loadTableOccupation() {
    try {
        const response = await fetch('/api/table-occupation');
        if (!response.ok) throw new Error(`HTTP Error: ${response.status}`);
        const data = await response.json();

        globalOccupationData = data.tables || [];
        renderTableOccupation(globalOccupationData);
        renderDashboardActiveBanner();
    } catch (error) {
        console.error('Failed to load table occupation data:', error);
    }
}

// HELPER FUNCTION PARA SA SORTING NG MGA MESA
function sortTablesList(tables) {
    return [...tables].sort((a, b) => {
        const nameA = String(a.table_name || a.seat_plan || a || '').trim();
        const nameB = String(b.table_name || b.seat_plan || b || '').trim();

        // Kunin ang priority category
        const getPriority = (name) => {
            if (name.toLowerCase() === 'unassigned') return 3; // Huli
            if (name.toUpperCase().startsWith('VIP')) return 1; // Una
            return 2; // Regular tables
        };

        const priorityA = getPriority(nameA);
        const priorityB = getPriority(nameB);

        if (priorityA !== priorityB) {
            return priorityA - priorityB;
        }

        // Kunin ang numero para sa tamang sequential order (1, 2, 3...)
        const numA = parseInt(nameA.replace(/\D/g, ''), 10) || 0;
        const numB = parseInt(nameB.replace(/\D/g, ''), 10) || 0;

        return numA - numB;
    });
}

function renderTableOccupation(tables) {
    const mainGridContainer = document.getElementById('mainOccupationGrid');
    const standaloneContainer = document.getElementById('standaloneOccupationGrid');

    if (!tables || tables.length === 0) {
        const emptyHTML = `<p class="empty-state">No table assignments found.</p>`;
        if (mainGridContainer) mainGridContainer.innerHTML = emptyHTML;
        if (standaloneContainer) standaloneContainer.innerHTML = emptyHTML;
        return;
    }

    // Pagsunod-sunorin ang mga mesa: VIP 1-4 -> Regular Tables 1-N -> Unassigned
    const sortedTables = sortTablesList(tables);

    const dashboardCardsHTML = sortedTables.map(tbl => {
        const tableName = tbl.table_name || 'Unassigned';
        const total = tbl.total_guests || 0;
        const checked = tbl.checked_in_count || 0;
        const percentage = total > 0 ? Math.round((checked / total) * 100) : 0;
        const isFull = total > 0 && checked === total;

        return `
            <div class="table-card-item table-occupation-card ${isFull ? 'table-full' : ''}" 
                 data-table-name="${escapeHtml(tableName)}" 
                 title="Click to filter guest list">
                <div class="table-occupation-header" style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 8px;">
                    <strong style="font-size: 1rem;">${escapeHtml(tableName)}</strong>
                    <span class="table-count-badge" style="font-size: 0.85rem; font-weight:600;">
                        ${checked} / ${total}
                    </span>
                </div>
                <div class="table-progress-bar-bg" style="width:100%; height:8px; background:var(--border-color, #e5e7eb); border-radius:4px; overflow:hidden;">
                    <div class="table-progress-bar-fill" style="width: ${percentage}%; height:100%; background:#10b981; transition: width 0.3s ease;"></div>
                </div>
            </div>
        `;
    }).join('');

    const seatingOverviewCardsHTML = sortedTables.map(tbl => {
        const tableName = tbl.table_name || 'Unassigned';
        const total = tbl.total_guests || 0;
        const checked = tbl.checked_in_count || 0;
        const percentage = total > 0 ? Math.round((checked / total) * 100) : 0;
        const isFull = total > 0 && checked === total;

        return `
            <div class="table-card-item table-occupation-card ${isFull ? 'table-full' : ''}" 
                 data-table-name="${escapeHtml(tableName)}" 
                 title="Click to view guests">
                <div class="table-occupation-header" style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 8px;">
                    <strong style="font-size: 1rem;">${escapeHtml(tableName)}</strong>
                    <span class="table-count-badge" style="font-size: 0.85rem; font-weight:600;">
                        <strong style="color: #10b981;">${checked}</strong> / ${total}
                    </span>
                </div>
                <div class="table-progress-bar-bg" style="width:100%; height:8px; background:var(--border-color, #e5e7eb); border-radius:4px; overflow:hidden;">
                    <div class="table-progress-bar-fill" style="width: ${percentage}%; height:100%; background:#10b981; transition: width 0.3s ease;"></div>
                </div>
            </div>
        `;
    }).join('');

    if (mainGridContainer) mainGridContainer.innerHTML = dashboardCardsHTML;
    if (standaloneContainer) standaloneContainer.innerHTML = seatingOverviewCardsHTML;
}

/* ==========================================
   SEATING CAPACITY OVERVIEW
   ========================================== */
async function openTableModal(tableName) {
    const modal = document.getElementById('tableGuestsModal');
    const titleEl = document.getElementById('tableModalTitle');
    const listEl = document.getElementById('tableGuestsList');

    if (!modal || !listEl) return;

    if (titleEl) titleEl.textContent = `Seating Overview: ${tableName}`;

    listEl.innerHTML = '<li class="empty-state">Loading guests</li>';
    modal.style.display = 'flex';

    try {
        const res = await fetch(`/api/table-guests/${encodeURIComponent(tableName)}`);
        const data = await res.json();
        const tableGuests = data.guests || [];

        if (tableGuests.length === 0) {
            listEl.innerHTML = `<li class="empty-state" style="padding: 12px 0; list-style: none;">No guests assigned to this table.</li>`;
        } else {
            listEl.innerHTML = tableGuests.map(g => {
                const isCheckedIn = g.status === 'Checked-In';
                
                return `
                    <li style="display: flex; justify-content: space-between; align-items: center; padding: 10px 0; border-bottom: 1px solid var(--border-color, #333);">
                        <div style="display: flex; align-items: center; gap: 12px;">
                            <div>
                                <strong>${escapeHtml(g.name)}</strong>
                                ${g.nickname ? `<small style="opacity: 0.7; margin-left: 6px;">(${escapeHtml(g.nickname)})</small>` : ''}
                                <div style="font-size: 0.75rem; color: var(--subtext-color, #888);">Category: ${escapeHtml(g.category || 'Guest')}</div>
                            </div>
                        </div>
                        <span class="status-indicator ${isCheckedIn ? 'status-checked' : 'status-pending'}" style="font-size: 0.85rem;">
                            ${escapeHtml(g.status || 'Not Checked-In')}
                        </span>
                    </li>
                `;
            }).join('');
        }
    } catch (err) {
        console.error('Error fetching table details:', err);
        listEl.innerHTML = '<li class="empty-state">Error loading table details.</li>';
    }
}

function closeTableModal() {
    const modal = document.getElementById('tableGuestsModal');
    if (modal) modal.style.display = 'none';
}

/* ==========================================
   DYNAMIC DROPDOWNS, FILTERS & SORTING
   ========================================== */
function populateTableDropdown() {
    const tableSelect = document.getElementById('filterTable');
    if (!tableSelect) return;

    const currentSelection = tableSelect.value;
    const uniqueTables = [...new Set(guests.map(g => g.seat_plan))].filter(Boolean);

    // Sundin din ang VIP 1-4 -> Regular 1-N -> Unassigned sorting
    const sortedTables = sortTablesList(uniqueTables);

    tableSelect.innerHTML = '<option value="">All Tables</option>';
    sortedTables.forEach(tbl => {
        const option = document.createElement('option');
        option.value = tbl;
        option.textContent = tbl;
        if (tbl === currentSelection) option.selected = true;
        tableSelect.appendChild(option);
    });
}

function applyFilters() {
    const query = (document.getElementById('search')?.value || '').trim().toLowerCase();
    const categoryValue = document.getElementById('filterCategory')?.value || '';
    const tableValue = document.getElementById('filterTable')?.value || '';
    const sortBy = document.getElementById('sortBy')?.value || 'name-asc';

    let filtered = guests.filter(g => {
        const matchesSearch = !query || 
                              (g.name && g.name.toLowerCase().includes(query)) ||
                              (g.nickname && g.nickname.toLowerCase().includes(query));
        const matchesCategory = categoryValue === '' || (g.category && g.category.toUpperCase() === categoryValue.toUpperCase());
        const matchesTable = tableValue === '' || g.seat_plan === tableValue;

        return matchesSearch && matchesCategory && matchesTable;
    });

    // Apply Dynamic Sorting Logic
    filtered.sort((a, b) => {
        const nameA = (a.name || '').trim();
        const nameB = (b.name || '').trim();
        const tableA = (a.seat_plan || 'Unassigned').trim();
        const tableB = (b.seat_plan || 'Unassigned').trim();
        const statusA = (a.status || '').toLowerCase();
        const statusB = (b.status || '').toLowerCase();
        const timeA = a.check_in_time ? new Date(a.check_in_time).getTime() : 0;
        const timeB = b.check_in_time ? new Date(b.check_in_time).getTime() : 0;

        switch (sortBy) {
            case 'name-desc':
                return nameB.localeCompare(nameA);
            case 'table-asc':
                return tableA.localeCompare(tableB, undefined, { numeric: true, sensitivity: 'base' });
            case 'status-checked':
                if (statusA === 'checked-in' && statusB !== 'checked-in') return -1;
                if (statusA !== 'checked-in' && statusB === 'checked-in') return 1;
                return nameA.localeCompare(nameB);
            case 'status-unchecked':
                if (statusA !== 'checked-in' && statusB === 'checked-in') return -1;
                if (statusA === 'checked-in' && statusB !== 'checked-in') return 1;
                return nameA.localeCompare(nameB);
            case 'time-desc':
                return timeB - timeA;
            case 'name-asc':
            default:
                return nameA.localeCompare(nameB);
        }
    });

    renderTable(filtered);
    updateCounters(filtered);
    renderDashboardActiveBanner();
}

function updateCounters(guestsList) {
    const list = guestsList || [];
    const total = list.length;
    const checked = list.filter(g => g.status === 'Checked-In').length;
    const notChecked = total - checked;

    const totalEl = document.getElementById('stat-total');
    const checkedEl = document.getElementById('stat-checked');
    const notCheckedEl = document.getElementById('stat-not-checked');

    if (totalEl) totalEl.innerText = total;
    if (checkedEl) checkedEl.innerText = checked;
    if (notCheckedEl) notCheckedEl.innerText = notChecked;
}

/* ==========================================
   RENDER MAIN DASHBOARD TABLE
   ========================================== */
function renderTable(data) {
    const tbody = document.getElementById('guestTable');
    if (!tbody) return;

    if (data.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="7" style="text-align: center; padding: 20px; color: var(--subtext-color, #888);">
                    No guests found.
                </td>
            </tr>
        `;
        return;
    }

    tbody.innerHTML = data.map(guest => {
        const isCheckedIn = guest.status === 'Checked-In';
        const categoryClass = guest.category && guest.category.toUpperCase() === 'VIP' ? 'badge-vip' : 'badge-guest';

        const actionControls = !isCheckedIn ? `
            <button class="btn btn-sm btn-primary btn-checkin">Check In</button>
            <button class="btn btn-sm btn-outline btn-edit" title="Edit guest info">Edit</button>
            <button class="btn btn-sm btn-danger btn-delete" title="Delete guest">Remove</button>
        ` : `
            <button class="btn btn-sm btn-success" disabled>✓ Done</button>
            <button class="btn btn-sm btn-warning btn-undo" title="Undo check-in">Undo</button>
            <button class="btn btn-sm btn-outline btn-edit" title="Edit guest info">Edit</button>
            <button class="btn btn-sm btn-danger btn-delete" title="Delete guest">Remove</button>
        `;

        return `
            <tr id="guest-${guest.id}" data-id="${guest.id}" class="${isCheckedIn ? 'checked-in-row' : ''}">
                <td><strong>${escapeHtml(guest.name)}</strong></td>
                <td>${escapeHtml(guest.nickname || '-')}</td>
                <td><span class="${categoryClass}">${escapeHtml(guest.category || 'Guest')}</span></td>
                <td>${escapeHtml(guest.seat_plan || 'Unassigned')}</td>
                <td><span class="status-indicator ${isCheckedIn ? 'status-checked' : 'status-pending'}">${escapeHtml(guest.status || 'Not Checked-In')}</span></td>
                <td class="time">${escapeHtml(guest.check_in_time || '-')}</td>
                <td>
                    <div style="display:flex; align-items:center; gap:6px;">
                        ${actionControls}
                    </div>
                </td>
            </tr>
        `;
    }).join('');
}

function checkIn(id) { socket.emit('checkIn', { id }); }
function uncheckIn(id) { socket.emit('uncheckIn', { id }); }

/* ==========================================
   MODAL DIALOGS & EDIT GUEST LOGIC
   ========================================== */
function setupModalKeybinds() {
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            if (document.getElementById('editModal')?.style.display === 'flex') {
                closeEditModal();
            }
            if (document.getElementById('tableGuestsModal')?.style.display === 'flex') {
                closeTableModal();
            }
        }
    });
}

function openAddGuestModal() {
    document.getElementById('editGuestId').value = '';
    document.getElementById('editName').value = '';
    document.getElementById('editNickname').value = '';
    document.getElementById('editCategory').value = 'Guest';
    document.getElementById('editTable').value = '';

    const titleEl = document.getElementById('editModalTitle');
    if (titleEl) titleEl.textContent = 'Add Guest';

    const modal = document.getElementById('editModal');
    if (modal) {
        modal.style.display = 'flex';
        document.getElementById('editName').focus();
    }
}

function editGuest(id) {
    const guest = guests.find(g => String(g.id) === String(id));
    if (!guest) return;

    document.getElementById('editGuestId').value = guest.id;
    document.getElementById('editName').value = guest.name || '';
    document.getElementById('editNickname').value = guest.nickname || '';
    document.getElementById('editCategory').value = (guest.category && guest.category.toUpperCase() === 'VIP') ? 'VIP' : 'Guest';
    document.getElementById('editTable').value = guest.seat_plan || '';

    const titleEl = document.getElementById('editModalTitle');
    if (titleEl) titleEl.textContent = 'Edit Guest Details';

    const modal = document.getElementById('editModal');
    if (modal) {
        modal.style.display = 'flex';
        document.getElementById('editName').focus();
    }
}

function closeEditModal() {
    const modal = document.getElementById('editModal');
    if (modal) modal.style.display = 'none';
}

async function saveGuestEdit(e) {
    e.preventDefault();

    const id = document.getElementById('editGuestId').value;
    const newName = document.getElementById('editName').value.trim();
    const newNickname = document.getElementById('editNickname').value.trim();
    const newCategory = document.getElementById('editCategory').value;
    const newTable = document.getElementById('editTable').value.trim();

    if (!newName) {
        alert('Please enter a guest name.');
        return;
    }

    const isEdit = Boolean(id);
    const url = isEdit ? `/api/guests/${id}` : '/api/guests';
    const method = isEdit ? 'PUT' : 'POST';

    try {
        const res = await fetch(url, {
            method: method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: newName,
                nickname: newNickname,
                category: newCategory,
                seat_plan: newTable || 'Unassigned'
            })
        });

        if (res.ok) {
            closeEditModal();
            loadGuests();
        } else {
            const errData = await res.json().catch(() => ({}));
            alert(errData.error || 'Failed to save guest info.');
        }
    } catch (err) {
        console.error('Save error:', err);
        alert('Network error while saving changes.');
    }
}

async function deleteGuest(id) {
    if (confirm('Are you sure you want to delete this guest?')) {
        try {
            const res = await fetch(`/api/guests/${id}`, { method: 'DELETE' });
            if (res.ok) {
                loadGuests();
            } else {
                alert('Failed to delete guest.');
            }
        } catch (err) {
            console.error('Delete error:', err);
            alert('Failed to delete guest.');
        }
    }
}

/* ==========================================
   EXPORTS & HELPERS
   ========================================== */
function exportExcel() {
    window.location.href = '/api/export?format=excel';
}

function exportDocs() {
    window.location.href = '/api/export?format=docs';
}

function escapeHtml(text) {
    if (text === null || text === undefined) return '';
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

/* ==========================================
   SOCKET LISTENERS
   ========================================== */
socket.on('guestUpdated', ({ id, status, check_in_time }) => {
    const guestIndex = guests.findIndex(g => String(g.id) === String(id));
    if (guestIndex !== -1) {
        guests[guestIndex].status = status;
        guests[guestIndex].check_in_time = check_in_time;
    }
    applyFilters();
    loadTableOccupation();
});

socket.on('guestListReload', () => {
    loadGuests();
    fetchRecentFiles();
});

socket.on('tableOccupationUpdated', () => {
    loadTableOccupation();
});

socket.on('error', (data) => {
    if (data && data.message) {
        alert(data.message);
    }
});