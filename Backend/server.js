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
   MULTER CONFIGURATION (HYBRID DISK / MEMORY)
   ========================================== */
// Standard disk storage for persistent uploaded physical files
const diskStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        const baseName = path.basename(file.originalname, ext);
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e4);
        cb(null, `${baseName}-${uniqueSuffix}${ext}`);
    }
});

// Primary file upload handler (supports disk + memory buffer backup for cloud platforms like Render)
const upload = multer({ 
    storage: diskStorage,
    limits: { fileSize: 15 * 1024 * 1024 } // 15MB Limit
});

// Memory storage instance specifically for direct file stream imports
const memoryUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 15 * 1024 * 1024 }
});

app.use(express.json());

/* ==========================================
   RESPONSIVE DYNAMIC STATIC FILE SERVING
   ========================================== */
// Auto-detect public folder location across different deployment setups
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

// Enable Write-Ahead Logging (WAL) for faster execution & concurrent reads/writes
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

// Dynamic Schema Migration Check
const columns = db.pragma('table_info(guests)');
const hasQrCode = columns.some(col => col.name === 'qr_code');
if (!hasQrCode) {
    db.exec(`ALTER TABLE guests ADD COLUMN qr_code TEXT`);
}

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
        return await QRCode.toDataURL(JSON.stringify(payloadObj));
    } catch (err) {
        console.error('Error generating QR Code:', err);
        return null;
    }
}

// Flexible Excel Parser that supports both File Paths and RAM Buffers
function parseAndInsertExcel(fileInput) {
    let workbook;
    if (Buffer.isBuffer(fileInput)) {
        workbook = XLSX.read(fileInput, { type: 'buffer' });
    } else if (typeof fileInput === 'string') {
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
        // Safe to ignore if sqlite_sequence table does not exist
    }
}

async function bulkInsertGuests(guests) {
    if (!guests || guests.length === 0) return;

    const insertStmt = db.prepare(
        `INSERT INTO guests (name, nickname, category, seat_plan, qr_code) VALUES (?, ?, ?, ?, ?)`
    );
    const updateQrStmt = db.prepare(
        `UPDATE guests SET qr_code = ? WHERE id = ?`
    );

    const insertTransaction = db.transaction(async (guestList) => {
        for (const g of guestList) {
            const res = insertStmt.run(g.name, g.nickname, g.category, g.seat_plan, null);
            const insertedId = res.lastInsertRowid;
            const qrDataUrl = await generateQrCodeDataUrl({ id: insertedId, name: g.name, table: g.seat_plan });
            updateQrStmt.run(qrDataUrl, insertedId);
        }
    });

    await insertTransaction(guests);
}

function notifyTableOccupationChange() {
    const query = `
        SELECT 
            seat_plan AS table_name,
            COUNT(*) AS total_guests,
            SUM(CASE WHEN status = 'Checked-In' THEN 1 ELSE 0 END) AS checked_in_count
        FROM guests
        GROUP BY seat_plan
        ORDER BY seat_plan ASC
    `;
    try {
        const rows = db.prepare(query).all();
        io.emit('tableOccupationUpdated', { tables: rows });
    } catch (err) {
        console.error('Error in notifyTableOccupationChange:', err.message);
    }
}

function notifyDashboardMetricsChange() {
    const query = `
        SELECT 
            COUNT(*) AS total_guests,
            SUM(CASE WHEN status = 'Checked-In' THEN 1 ELSE 0 END) AS checked_in,
            SUM(CASE WHEN status = 'Not Checked-In' OR status IS NULL THEN 1 ELSE 0 END) AS not_checked_in,
            SUM(CASE WHEN category = 'VIP' THEN 1 ELSE 0 END) AS vip_count
        FROM guests
    `;
    try {
        const row = db.prepare(query).get();
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
        try {
            parsedData = JSON.parse(qrPayload);
        } catch (e) {
            parsedData = { raw: qrPayload };
        }
    } else if (typeof qrPayload === 'object' && qrPayload !== null) {
        parsedData = qrPayload;
    }

    if (!parsedData) {
        throw new Error('Invalid QR Payload format.');
    }

    const checkInTimeStr = new Date().toLocaleTimeString([], { 
        hour: '2-digit', 
        minute: '2-digit', 
        second: '2-digit' 
    });

    let guest = null;

    if (parsedData.id) {
        guest = db.prepare('SELECT * FROM guests WHERE id = ?').get(parsedData.id);
    } else if (parsedData.name) {
        guest = db.prepare('SELECT * FROM guests WHERE LOWER(name) = LOWER(?)').get(parsedData.name.trim());
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

    db.prepare(`UPDATE guests SET status = 'Checked-In', check_in_time = ? WHERE id = ?`).run(checkInTimeStr, guest.id);

    const updatedGuest = { ...guest, status: 'Checked-In', check_in_time: checkInTimeStr };
    
    io.emit('guestUpdated', { id: guest.id, status: 'Checked-In', check_in_time: checkInTimeStr });
    notifyTableOccupationChange();
    notifyDashboardMetricsChange();

    return {
        success: true,
        message: `Successfully checked-in ${guest.name}!`,
        guest: updatedGuest
    };
}

/* ==========================================
   SOCKET.IO REAL-TIME CHECK-IN LISTENERS
   ========================================== */
io.on('connection', (socket) => {
    socket.on('checkIn', ({ id }) => {
        const checkInTimeStr = new Date().toLocaleTimeString([], { 
            hour: '2-digit', 
            minute: '2-digit', 
            second: '2-digit' 
        });

        try {
            const res = db.prepare(`UPDATE guests SET status = 'Checked-In', check_in_time = ? WHERE id = ?`).run(checkInTimeStr, id);
            if (res.changes > 0) {
                io.emit('guestUpdated', { id, status: 'Checked-In', check_in_time: checkInTimeStr });
                notifyTableOccupationChange();
                notifyDashboardMetricsChange();
            }
        } catch (err) {
            console.error('Socket checkIn error:', err.message);
        }
    });

    socket.on('uncheckIn', ({ id }) => {
        try {
            const res = db.prepare(`UPDATE guests SET status = 'Not Checked-In', check_in_time = NULL WHERE id = ?`).run(id);
            if (res.changes > 0) {
                io.emit('guestUpdated', { id, status: 'Not Checked-In', check_in_time: null });
                notifyTableOccupationChange();
                notifyDashboardMetricsChange();
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

app.get('/api/dashboard-summary', (req, res) => {
    const query = `
        SELECT 
            COUNT(*) AS total_guests,
            SUM(CASE WHEN status = 'Checked-In' THEN 1 ELSE 0 END) AS checked_in,
            SUM(CASE WHEN status = 'Not Checked-In' OR status IS NULL THEN 1 ELSE 0 END) AS not_checked_in,
            SUM(CASE WHEN category = 'VIP' THEN 1 ELSE 0 END) AS vip_count
        FROM guests
    `;
    try {
        const row = db.prepare(query).get();
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
        const rows = db.prepare('SELECT * FROM guests ORDER BY name ASC').all();
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
        const result = db.prepare(
            `INSERT INTO guests (name, nickname, category, seat_plan) VALUES (?, ?, ?, ?)`
        ).run(name, nickname || '', guestCategory, guestSeat);

        const newId = result.lastInsertRowid;
        const qrDataUrl = await generateQrCodeDataUrl({ id: newId, name, table: guestSeat });

        db.prepare(`UPDATE guests SET qr_code = ? WHERE id = ?`).run(qrDataUrl, newId);
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
    const checkInTimeStr = isCheckIn 
        ? new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) 
        : null;

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
        const guest = db.prepare('SELECT * FROM guests WHERE id = ?').get(guestId);
        if (!guest) return res.status(404).json({ error: 'Guest not found.' });

        if (guest.qr_code) {
            return res.json({ id: guest.id, qrCode: guest.qr_code });
        }

        const qrPayload = {
            id: guest.id,
            name: guest.name,
            table: guest.seat_plan
        };

        const qrDataUrl = await generateQrCodeDataUrl(qrPayload);
        db.prepare('UPDATE guests SET qr_code = ? WHERE id = ?').run(qrDataUrl, guestId);

        res.json({ id: guest.id, qrCode: qrDataUrl });
    } catch (err) {
        console.error('QR Generation Error:', err);
        res.status(500).json({ error: 'Failed to generate QR Code.' });
    }
});

app.get('/api/table-occupation', (req, res) => {
    const query = `
        SELECT 
            seat_plan AS table_name,
            COUNT(*) AS total_guests,
            SUM(CASE WHEN status = 'Checked-In' THEN 1 ELSE 0 END) AS checked_in_count
        FROM guests
        GROUP BY seat_plan
        ORDER BY seat_plan ASC
    `;

    try {
        const rows = db.prepare(query).all();
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
        db.prepare(`DELETE FROM guests WHERE id = ?`).run(req.params.id);
        triggerRealtimeUpdates();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/* ==========================================
   UPDATED /API/IMPORT ENDPOINT (DYNAMIC DISK/MEMORY)
   ========================================== */
app.post('/api/import', (req, res) => {
    // Dynamically fallback to memory upload if disk-write fails or is restricted on Render
    upload.single('file')(req, res, async (err) => {
        if (err || !req.file) {
            // Memory storage retry logic
            return memoryUpload.single('file')(req, res, async (memErr) => {
                if (memErr || !req.file) {
                    return res.status(400).json({ error: 'File upload failed. Please send a valid Excel (.xlsx) file.' });
                }
                await processImportFile(req, res);
            });
        }
        await processImportFile(req, res);
    });
});

async function processImportFile(req, res) {
    try {
        // Read either buffer memory or file path based on upload type
        const fileData = req.file.buffer ? req.file.buffer : req.file.path;
        const importedGuests = parseAndInsertExcel(fileData);

        if (importedGuests.length === 0) {
            if (req.file.path) safeUnlink(req.file.path);
            return res.status(400).json({ error: 'No valid guests found in the file.' });
        }

        clearGuestsTable();
        await bulkInsertGuests(importedGuests);

        // Clean up temporary disk file if applicable
        if (req.file.path) safeUnlink(req.file.path);

        triggerRealtimeUpdates();
        res.json({ 
            success: true, 
            count: importedGuests.length, 
            activeFile: req.file.originalname 
        });
    } catch (error) {
        console.error('Import Processing Error:', error);
        if (req.file && req.file.path) safeUnlink(req.file.path);
        res.status(500).json({ error: 'Failed to process Excel file. Please verify file formatting.' });
    }
}

app.get('/api/export', (req, res) => {
    const format = (req.query.format || 'excel').toLowerCase();

    try {
        const rows = db.prepare('SELECT * FROM guests ORDER BY name ASC').all();

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