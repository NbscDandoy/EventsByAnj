const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Database = require('better-sqlite3');
const multer = require('multer');
const XLSX = require('xlsx');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Ensure uploads directory exists on server start
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

/* ==========================================
   HELPER FOR PHILIPPINE STANDARD TIME (PST)
   ========================================== */
function getPhilippineTime() {
    const now = new Date();
    const dateStr = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' }); // YYYY-MM-DD
    const timeStr = now.toLocaleTimeString('en-US', {
        timeZone: 'Asia/Manila',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: true
    });
    return `${dateStr} ${timeStr}`;
}

/* ==========================================
   MULTER CONFIGURATION (MEMORY STORAGE)
   ========================================== */
const upload = multer({ 
    storage: multer.memoryStorage(),
    limits: { fileSize: 15 * 1024 * 1024 } // 15MB Limit
});

app.use(express.json());

/* ==========================================
   DYNAMIC STATIC FILE SERVING
   ========================================== */
const possiblePublicPaths = [
    path.join(__dirname, '..', 'Frontend', 'public'),
    path.join(__dirname, 'public'),
    path.join(__dirname, '..', 'public')
];

let publicPath = possiblePublicPaths.find(p => fs.existsSync(p)) || possiblePublicPaths[0];
app.use(express.static(publicPath));

/* ==========================================
   DATABASE INITIALIZATION & MIGRATIONS
   ========================================== */
const dbPath = path.join(__dirname, 'events.db');
const db = new Database(dbPath);

// Enable Write-Ahead Logging (WAL) for better performance
db.pragma('journal_mode = WAL');

db.exec(`
    CREATE TABLE IF NOT EXISTS guests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        nickname TEXT,
        category TEXT,
        seat_plan TEXT,
        status TEXT DEFAULT 'Not Checked-In',
        check_in_time TEXT,
        qr_code TEXT
    )
`);

// Clean direct column schema check
const columns = db.pragma('table_info(guests)');
if (!columns.some(col => col.name === 'qr_code')) {
    db.exec(`ALTER TABLE guests ADD COLUMN qr_code TEXT`);
}

/* ==========================================
   PREPARED STATEMENTS (REUSABLE & OPTIMIZED)
   ========================================== */
const stmtSelectAllGuests = db.prepare('SELECT * FROM guests ORDER BY name ASC');
const stmtSelectGuestById = db.prepare('SELECT * FROM guests WHERE id = ?');
const stmtSelectGuestByName = db.prepare('SELECT * FROM guests WHERE LOWER(name) = LOWER(?)');
const stmtInsertGuest = db.prepare('INSERT INTO guests (name, nickname, category, seat_plan, qr_code) VALUES (?, ?, ?, ?, ?)');
const stmtUpdateQrCode = db.prepare('UPDATE guests SET qr_code = ? WHERE id = ?');
const stmtUpdateStatus = db.prepare('UPDATE guests SET status = ?, check_in_time = ? WHERE id = ?');
const stmtDeleteGuest = db.prepare('DELETE FROM guests WHERE id = ?');

const stmtDashboardMetrics = db.prepare(`
    SELECT 
        COUNT(*) AS total_guests,
        SUM(CASE WHEN status = 'Checked-In' THEN 1 ELSE 0 END) AS checked_in,
        SUM(CASE WHEN status = 'Not Checked-In' OR status IS NULL THEN 1 ELSE 0 END) AS not_checked_in,
        SUM(CASE WHEN category = 'VIP' THEN 1 ELSE 0 END) AS vip_count
    FROM guests
`);

const stmtTableOccupation = db.prepare(`
    SELECT 
        seat_plan AS table_name,
        COUNT(*) AS total_guests,
        SUM(CASE WHEN status = 'Checked-In' THEN 1 ELSE 0 END) AS checked_in_count
    FROM guests
    GROUP BY seat_plan
    ORDER BY seat_plan ASC
`);

/* ==========================================
   HELPER FUNCTIONS & REAL-TIME EMITTERS
   ========================================== */
function safeUnlink(filePath) {
    if (filePath && fs.existsSync(filePath)) {
        try {
            fs.unlinkSync(filePath);
        } catch (err) {
            console.error(`Failed to delete file ${filePath}:`, err.message);
        }
    }
}

function escapeHtml(text) {
    if (!text) return '';
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function isPathInsideDir(targetPath, parentDir) {
    const relative = path.relative(parentDir, targetPath);
    return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function generateQrCodeDataUrl(payloadObj) {
    try {
        return await QRCode.toDataURL(typeof payloadObj === 'string' ? payloadObj : JSON.stringify(payloadObj));
    } catch (err) {
        console.error('Error generating QR Code:', err);
        return null;
    }
}

function parseAndInsertExcel(fileInput) {
    let workbook;
    if (Buffer.isBuffer(fileInput)) {
        workbook = XLSX.read(fileInput, { type: 'buffer' });
    } else if (typeof fileInput === 'string' && fs.existsSync(fileInput)) {
        workbook = XLSX.readFile(fileInput);
    } else {
        throw new Error('Invalid file payload provided.');
    }

    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    
    const rawRows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    const importedGuests = [];

    rawRows.forEach(row => {
        const keys = Object.keys(row);
        const nameKey = keys.find(k => k.toLowerCase().includes('name (surname') || k.toLowerCase().includes('name') || k.toLowerCase().includes('guest'));
        const nicknameKey = keys.find(k => k.toLowerCase().includes('name tag') || k.toLowerCase().includes('nickname') || k.toLowerCase().includes('alias'));
        const tableKey = keys.find(k => k.toLowerCase().includes('table no') || k.toLowerCase().includes('table') || k.toLowerCase().includes('seat'));
        const vipKey = keys.find(k => k.toLowerCase().includes('vip') || k.toLowerCase().includes('category'));

        const guestName = row[nameKey] ? String(row[nameKey]).trim() : '';
        if (!guestName || guestName.toLowerCase().includes('total')) return;

        const nickname = row[nicknameKey] ? String(row[nicknameKey]).trim() : '';
        const rawTable = row[tableKey] ? String(row[tableKey]).trim() : 'Unassigned';
        
        const isVipMarked = row[vipKey] && (String(row[vipKey]) === '1' || String(row[vipKey]).toLowerCase() === 'true' || String(row[vipKey]).toLowerCase() === 'vip');
        const isVipTable = rawTable.toUpperCase().includes('VIP');

        const category = (isVipMarked || isVipTable) ? 'VIP' : 'Guest';

        importedGuests.push({
            name: guestName,
            nickname: nickname,
            category: category,
            seat_plan: rawTable
        });
    });

    return importedGuests;
}

function clearGuestsTable() {
    db.prepare('DELETE FROM guests').run();
    try {
        db.prepare("DELETE FROM sqlite_sequence WHERE name='guests'").run();
    } catch (err) {
        // Safe to ignore if sequence table doesn't exist
    }
}

// Optimized Bulk Insertion with Parallel QR Generation
async function bulkInsertGuests(guests) {
    if (!guests || guests.length === 0) return;

    const insertedRecords = [];

    const runTransaction = db.transaction((list) => {
        for (const g of list) {
            const res = stmtInsertGuest.run(g.name, g.nickname, g.category, g.seat_plan, null);
            insertedRecords.push({ id: res.lastInsertRowid, name: g.name, table: g.seat_plan });
        }
    });

    runTransaction(guests);

    // Parallel QR Code Generation for performance
    await Promise.all(
        insertedRecords.map(async (record) => {
            const qrDataUrl = await generateQrCodeDataUrl({ id: record.id, name: record.name, table: record.table });
            stmtUpdateQrCode.run(qrDataUrl, record.id);
        })
    );
}

function notifyTableOccupationChange() {
    try {
        const rows = stmtTableOccupation.all();
        io.emit('tableOccupationUpdated', { tables: rows });
    } catch (err) {
        console.error('Error in notifyTableOccupationChange:', err.message);
    }
}

function notifyDashboardMetricsChange() {
    try {
        const row = stmtDashboardMetrics.get();
        io.emit('dashboardMetricsUpdated', {
            total_guests: row ? row.total_guests || 0 : 0,
            checked_in: row ? row.checked_in || 0 : 0,
            not_checked_in: row ? row.not_checked_in || 0 : 0,
            vip_count: row ? row.vip_count || 0 : 0
        });
    } catch (err) {
        console.error('Error in notifyDashboardMetricsChange:', err.message);
    }
}

function triggerRealtimeUpdates() {
    io.emit('guestListReload');
    notifyTableOccupationChange();
    notifyDashboardMetricsChange();
}

async function processQrScanCheckIn(qrPayload) {
    let parsedData = null;
    
    if (typeof qrPayload === 'string') {
        try { parsedData = JSON.parse(qrPayload); } catch (e) { parsedData = { raw: qrPayload }; }
    } else if (typeof qrPayload === 'object' && qrPayload !== null) {
        parsedData = qrPayload;
    }

    if (!parsedData) throw new Error('Invalid QR Payload format.');

    const checkInTimeStr = getPhilippineTime();
    let guest = null;

    if (parsedData.id) {
        guest = stmtSelectGuestById.get(parsedData.id);
    } else if (parsedData.name) {
        guest = stmtSelectGuestByName.get(parsedData.name.trim());
    } else if (parsedData.raw) {
        guest = db.prepare('SELECT * FROM guests WHERE id = ? OR LOWER(name) = LOWER(?)').get(parsedData.raw, parsedData.raw.trim());
    } else {
        throw new Error('QR Code contains missing guest information.');
    }

    if (!guest) throw new Error('Guest not found in database.');

    if (guest.status === 'Checked-In') {
        return {
            alreadyCheckedIn: true,
            message: `${guest.name} is ALREADY checked in!`,
            guest
        };
    }

    stmtUpdateStatus.run('Checked-In', checkInTimeStr, guest.id);

    const updatedGuest = { ...guest, status: 'Checked-In', check_in_time: checkInTimeStr };
    
    io.emit('guestUpdated', { id: guest.id, status: 'Checked-In', check_in_time: checkInTimeStr });
    triggerRealtimeUpdates();

    return {
        success: true,
        message: `Successfully checked-in ${guest.name}!`,
        guest: updatedGuest
    };
}

/* ==========================================
   SOCKET.IO REAL-TIME LISTENERS
   ========================================== */
io.on('connection', (socket) => {
    socket.on('checkIn', ({ id }) => {
        const checkInTimeStr = getPhilippineTime();
        try {
            const res = stmtUpdateStatus.run('Checked-In', checkInTimeStr, id);
            if (res.changes > 0) {
                io.emit('guestUpdated', { id, status: 'Checked-In', check_in_time: checkInTimeStr });
                triggerRealtimeUpdates();
            }
        } catch (err) {
            console.error('Socket checkIn error:', err.message);
        }
    });

    socket.on('uncheckIn', ({ id }) => {
        try {
            const res = stmtUpdateStatus.run('Not Checked-In', null, id);
            if (res.changes > 0) {
                io.emit('guestUpdated', { id, status: 'Not Checked-In', check_in_time: null });
                triggerRealtimeUpdates();
            }
        } catch (err) {
            console.error('Socket uncheckIn error:', err.message);
        }
    });

    socket.on('scanCheckIn', async (data, ackCallback) => {
        const qrPayload = data?.payload || data;
        try {
            const result = await processQrScanCheckIn(qrPayload);
            if (typeof ackCallback === 'function') {
                ackCallback(result);
            } else {
                socket.emit('scanCheckInResult', result);
            }
        } catch (err) {
            const errResp = { success: false, error: err.message };
            if (typeof ackCallback === 'function') {
                ackCallback(errResp);
            } else {
                socket.emit('scanCheckInResult', errResp);
            }
        }
    });
});

/* ==========================================
   REST API ENDPOINTS
   ========================================== */

// 1. PUBLIC SELF-REGISTRATION ENDPOINT (SMART MATCHING & INCLUDES TABLE NO.)
app.post('/api/register', async (req, res) => {
    const { name, nickname, category, seat_plan } = req.body;

    if (!name || name.trim() === '') {
        return res.status(400).json({ success: false, error: 'Pakilagay ang iyong pangalan.' });
    }

    const inputName = name.trim().toLowerCase();
    const cleanWords = inputName.replace(/[^a-z0-9\s]/gi, '').split(/\s+/).filter(Boolean);
    const checkInTimeStr = getPhilippineTime();

    try {
        const allGuests = stmtSelectAllGuests.all();

        // Smart Name Matching: Titignan kung nagtutugma ang First/Last name (halimbawa "Kyla abella" vs "Abella, Kyla Gelle L.")
        const matchedGuest = allGuests.find(g => {
            const dbNameLower = (g.name || '').toLowerCase();
            const dbCleanWords = dbNameLower.replace(/[^a-z0-9\s]/gi, '').split(/\s+/).filter(Boolean);

            if (dbNameLower === inputName) return true;

            // Kapag kahit 2 keywords ang nag-match sa DB entry
            const matchingWords = cleanWords.filter(word => dbCleanWords.includes(word));
            if (cleanWords.length >= 2 && matchingWords.length >= 2) return true;

            // Subukan ang simpleng substring check
            if (cleanWords.length === 1 && dbCleanWords.includes(cleanWords[0])) return true;

            return false;
        });

        if (matchedGuest) {
            // I-update ang umiiral na bisita imbes na gumawa ng duplicate
            stmtUpdateStatus.run('Checked-In', checkInTimeStr, matchedGuest.id);
            
            // I-update ang nickname kung may ipinasok ang bisita
            if (nickname && nickname.trim() !== '') {
                db.prepare('UPDATE guests SET nickname = ? WHERE id = ?').run(nickname.trim(), matchedGuest.id);
            }

            triggerRealtimeUpdates();

            return res.json({
                success: true,
                message: `Thank you for registering, ${matchedGuest.name}!`,
                table_no: matchedGuest.seat_plan || 'Unassigned',
                is_existing: true,
                guest: { ...matchedGuest, status: 'Checked-In', check_in_time: checkInTimeStr }
            });
        }

        // Kung WALA sa Excel file/Database, i-save bilang bagong Walk-in Guest
        const guestCategory = category || 'Walk-in Guest';
        const guestSeat = seat_plan || 'Unassigned';

        const result = db.prepare(`
            INSERT INTO guests (name, nickname, category, seat_plan, status, check_in_time)
            VALUES (?, ?, ?, ?, 'Checked-In', ?)
        `).run(name.trim(), nickname || '', guestCategory, guestSeat, checkInTimeStr);

        const newId = result.lastInsertRowid;
        const personalQr = await generateQrCodeDataUrl({ id: newId, name: name.trim(), table: guestSeat });
        stmtUpdateQrCode.run(personalQr, newId);

        triggerRealtimeUpdates();

        return res.json({
            success: true,
            message: `Thank you for registering, ${name.trim()}! Welcome to the event.`,
            table_no: guestSeat,
            is_existing: false,
            id: newId
        });

    } catch (err) {
        console.error('Registration Error:', err.message);
        res.status(500).json({ success: false, error: 'May problema sa pag-save ng registration.' });
    }
});

// 2. MASTER EVENT QR CODE GENERATOR
app.get('/api/event-qrcode', async (req, res) => {
    try {
        const hostUrl = `${req.protocol}://${req.get('host')}/register.html`;
        const qrDataUrl = await QRCode.toDataURL(hostUrl);

        res.json({
            success: true,
            registrationUrl: hostUrl,
            qrCode: qrDataUrl
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to generate Event QR Code' });
    }
});

app.get('/api/dashboard-summary', (req, res) => {
    try {
        const row = stmtDashboardMetrics.get();
        res.json({
            total_guests: row ? row.total_guests || 0 : 0,
            checked_in: row ? row.checked_in || 0 : 0,
            not_checked_in: row ? row.not_checked_in || 0 : 0,
            vip_count: row ? row.vip_count || 0 : 0
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/guests', (req, res) => {
    try {
        const rows = stmtSelectAllGuests.all();
        res.json({ guests: rows });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/guests', async (req, res) => {
    const { name, nickname, category, seat_plan } = req.body;
    if (!name) {
        return res.status(400).json({ error: 'Name is required.' });
    }

    const guestCategory = category || 'Guest';
    const guestSeat = seat_plan || 'Unassigned';

    try {
        const result = stmtInsertGuest.run(name, nickname || '', guestCategory, guestSeat, null);
        const newId = result.lastInsertRowid;
        const qrDataUrl = await generateQrCodeDataUrl({ id: newId, name, table: guestSeat });

        stmtUpdateQrCode.run(qrDataUrl, newId);
        triggerRealtimeUpdates();
        res.json({ success: true, id: newId, qrCode: qrDataUrl });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/guests/batch-checkin', (req, res) => {
    const { ids, status } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ error: 'Invalid or empty IDs array.' });
    }

    const isCheckIn = status !== 'Not Checked-In';
    const checkInTimeStr = isCheckIn ? getPhilippineTime() : null;

    const placeholders = ids.map(() => '?').join(',');
    const sql = `UPDATE guests SET status = ?, check_in_time = ? WHERE id IN (${placeholders})`;
    const params = [isCheckIn ? 'Checked-In' : 'Not Checked-In', checkInTimeStr, ...ids];

    try {
        const result = db.prepare(sql).run(...params);
        triggerRealtimeUpdates();
        res.json({ success: true, updatedCount: result.changes });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/scan-checkin', async (req, res) => {
    const { qrData, payload } = req.body;
    const targetPayload = qrData || payload;

    if (!targetPayload) {
        return res.status(400).json({ error: 'Missing QR code scanner data.' });
    }

    try {
        const result = await processQrScanCheckIn(targetPayload);
        res.json(result);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.delete('/api/guests/all', (req, res) => {
    try {
        clearGuestsTable();
        triggerRealtimeUpdates();
        res.json({ success: true, message: 'All guest records cleared.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/guests/:id/qrcode', async (req, res) => {
    const guestId = req.params.id;

    try {
        const guest = stmtSelectGuestById.get(guestId);
        if (!guest) return res.status(404).json({ error: 'Guest not found.' });

        if (guest.qr_code) {
            return res.json({ id: guest.id, qrCode: guest.qr_code });
        }

        const qrDataUrl = await generateQrCodeDataUrl({ id: guest.id, name: guest.name, table: guest.seat_plan });
        stmtUpdateQrCode.run(qrDataUrl, guestId);

        res.json({ id: guest.id, qrCode: qrDataUrl });
    } catch (err) {
        console.error('QR Generation Error:', err);
        res.status(500).json({ error: 'Failed to generate QR Code.' });
    }
});

app.get('/api/table-occupation', (req, res) => {
    try {
        const rows = stmtTableOccupation.all();
        res.json({ tables: rows });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/table-guests/:tableName', (req, res) => {
    const tableName = req.params.tableName;
    try {
        const rows = db.prepare(`SELECT * FROM guests WHERE seat_plan = ? ORDER BY name ASC`).all(tableName);
        res.json({ table_name: tableName, guests: rows });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/recent-files', (req, res) => {
    try {
        const entries = fs.readdirSync(uploadDir, { withFileTypes: true });
        const validFiles = entries
            .filter(entry => {
                if (!entry.isFile() || entry.name.startsWith('.')) return false;
                const ext = path.extname(entry.name).toLowerCase();
                return ['.xlsx', '.xls', '.csv'].includes(ext);
            })
            .map(entry => {
                const fullPath = path.join(uploadDir, entry.name);
                const stats = fs.statSync(fullPath);
                return { name: entry.name, time: stats.mtimeMs };
            })
            .sort((a, b) => b.time - a.time)
            .map(f => f.name);

        res.json({ files: validFiles });
    } catch (err) {
        console.error('Error reading upload directory:', err);
        res.status(500).json({ error: 'Unable to read uploads directory.' });
    }
});

app.post('/api/load-file', async (req, res) => {
    const fileName = req.query.name || req.body.fileName;
    if (!fileName) return res.status(400).json({ error: 'Filename is required.' });

    const safeFileName = path.basename(fileName);
    const filePath = path.join(uploadDir, safeFileName);

    if (!isPathInsideDir(filePath, uploadDir) || !fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'File not found on server.' });
    }

    try {
        const importedGuests = parseAndInsertExcel(filePath);
        clearGuestsTable();
        await bulkInsertGuests(importedGuests);

        triggerRealtimeUpdates();
        res.json({ success: true, count: importedGuests.length, activeFile: safeFileName });
    } catch (error) {
        console.error('Load File Error:', error);
        res.status(500).json({ error: 'Failed to process spreadsheet file.' });
    }
});

app.delete('/api/recent-files/:fileName', (req, res) => {
    const rawFileName = decodeURIComponent(req.params.fileName);
    const safeFileName = path.basename(rawFileName);
    const filePath = path.join(uploadDir, safeFileName);

    if (!isPathInsideDir(filePath, uploadDir)) {
        return res.status(400).json({ error: 'Invalid file path.' });
    }

    if (fs.existsSync(filePath)) {
        safeUnlink(filePath);
    }

    try {
        clearGuestsTable();
        triggerRealtimeUpdates();

        return res.json({ 
            success: true, 
            message: `File ${safeFileName} and associated guest records cleared.` 
        });
    } catch (err) {
        console.error('Error clearing database on file removal:', err.message);
        return res.status(500).json({ error: 'Failed to clear guest database.' });
    }
});

app.put('/api/guests/:id', async (req, res) => {
    const { name, nickname, category, seat_plan } = req.body;
    const guestId = req.params.id;

    try {
        const qrDataUrl = await generateQrCodeDataUrl({ id: guestId, name, table: seat_plan });

        db.prepare(
            `UPDATE guests SET name = ?, nickname = ?, category = ?, seat_plan = ?, qr_code = ? WHERE id = ?`
        ).run(name, nickname, category, seat_plan, qrDataUrl, guestId);

        triggerRealtimeUpdates();
        res.json({ success: true, qrCode: qrDataUrl });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/guests/:id', (req, res) => {
    try {
        stmtDeleteGuest.run(req.params.id);
        triggerRealtimeUpdates();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/* ==========================================
   IMPORT & EXPORT ENDPOINTS
   ========================================== */
app.post('/api/import', upload.single('file'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'File upload failed. Please send a valid Excel (.xlsx) file.' });
    }

    try {
        const importedGuests = parseAndInsertExcel(req.file.buffer);

        if (importedGuests.length === 0) {
            return res.status(400).json({ error: 'No valid guests found in the file.' });
        }

        clearGuestsTable();
        await bulkInsertGuests(importedGuests);

        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e4);
        const ext = path.extname(req.file.originalname) || '.xlsx';
        const baseName = path.basename(req.file.originalname, ext);
        const savePath = path.join(uploadDir, `${baseName}-${uniqueSuffix}${ext}`);
        fs.writeFileSync(savePath, req.file.buffer);

        triggerRealtimeUpdates();
        res.json({ 
            success: true, 
            count: importedGuests.length, 
            activeFile: req.file.originalname 
        });
    } catch (error) {
        console.error('Import Processing Error:', error);
        res.status(500).json({ error: 'Failed to process Excel file. Please verify file formatting.' });
    }
});

app.get('/api/export', (req, res) => {
    const format = (req.query.format || 'excel').toLowerCase();

    try {
        const rows = stmtSelectAllGuests.all();

        const formattedRows = rows.map(r => ({
            "Name": r.name || '',
            "Nickname": r.nickname || '-',
            "Category": r.category || 'Guest',
            "Table": r.seat_plan || 'Unassigned',
            "Status": r.status || 'Not Checked-In',
            "Check-In Time": r.check_in_time || '-'
        }));

        if (['docs', 'doc', 'word'].includes(format)) {
            let docHtml = `
                <html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'>
                <head>
                    <meta charset="utf-8">
                    <title>Guest List Export</title>
                    <style>
                        body { font-family: Arial, sans-serif; padding: 20px; background-color: #ffffff; color: #333333; }
                        h2 { color: #0066cc; }
                        table { width: 100%; border-collapse: collapse; margin-top: 15px; }
                        th, td { border: 1px solid #dddddd; padding: 8px 12px; text-align: left; }
                        th { background-color: #0066cc; color: #ffffff; }
                        tr:nth-child(even) { background-color: #f9f9f9; }
                    </style>
                </head>
                <body>
                    <h2>Events By Anj - Guest List</h2>
                    <table>
                        <thead>
                            <tr>
                                <th>Name</th>
                                <th>Nickname</th>
                                <th>Category</th>
                                <th>Table</th>
                                <th>Status</th>
                                <th>Check-In Time</th>
                            </tr>
                        </thead>
                        <tbody>
            `;

            formattedRows.forEach(r => {
                docHtml += `
                    <tr>
                        <td>${escapeHtml(r.Name)}</td>
                        <td>${escapeHtml(r.Nickname)}</td>
                        <td>${escapeHtml(r.Category)}</td>
                        <td>${escapeHtml(r.Table)}</td>
                        <td>${escapeHtml(r.Status)}</td>
                        <td>${escapeHtml(r["Check-In Time"])}</td>
                    </tr>
                `;
            });

            docHtml += `
                        </tbody>
                    </table>
                </body>
                </html>
            `;

            res.setHeader('Content-Type', 'application/msword');
            res.setHeader('Content-Disposition', 'attachment; filename="Guest_List_Export.doc"');
            return res.send(docHtml);
        } else {
            const worksheet = XLSX.utils.json_to_sheet(formattedRows);
            const workbook = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(workbook, worksheet, 'Attendee List');

            const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.setHeader('Content-Disposition', 'attachment; filename="Guest_List_Export.xlsx"');
            return res.send(buffer);
        }
    } catch (err) {
        console.error('Export Database Error:', err);
        return res.status(500).send('Database export error');
    }
});

/* ==========================================
   SERVER INITIALIZATION & GRACEFUL SHUTDOWN
   ========================================== */
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
});

let isShuttingDown = false;

function gracefulShutdown(signal) {
    if (isShuttingDown) return;
    isShuttingDown = true;

    console.log(`\nReceived ${signal}. Shutting down server gracefully`);

    const forceExitTimeout = setTimeout(() => {
        console.error('Forcefully terminating due to timeout.');
        process.exit(1);
    }, 5000);

    server.close(() => {
        console.log('HTTP/WebSocket server closed.');
        try {
            db.close();
            clearTimeout(forceExitTimeout);
            console.log('Database connection closed. Exiting process.');
            process.exit(0);
        } catch (err) {
            console.error('Error closing SQLite DB:', err.message);
            process.exit(1);
        }
    });
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));