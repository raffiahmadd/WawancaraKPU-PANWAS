// =====================================================================
// 1. CONFIG & SYSTEM STATE
// =====================================================================
const firebaseConfig = {
    apiKey: "AIzaSyDsaEfCu8TtAAVbZ1dVPvG5TWFuDw_EA0s",
    authDomain: "wawancara-b45d8.firebaseapp.com",
    databaseURL: "https://wawancara-b45d8-default-rtdb.firebaseio.com",
    projectId: "wawancara-b45d8",
    storageBucket: "wawancara-b45d8.firebasestorage.app",
    messagingSenderId: "679330553581",
    appId: "1:679330553581:web:446c44bf9c115d2c67b6e4"
};
if (!firebase.apps.length) { firebase.initializeApp(firebaseConfig); }
const db = firebase.database();

let currentUser = null;
let currentWorkSession = null;
let isEditMode = false;
let timerInterval = null;

let sysSettings = { webName: "SELEKSI WAWANCARA", status: "OPEN", durations: { POS_1: 300, POS_2: 300, POS_3: 300 } };
let dbParticipants = {};
let dbSessions = {};
let dbInstruments = {};
let auditLogsArray = [];

let activeTabKelompok = "1";
let parsedExcelData = [];
let activeExcelType = "";

// Fallback pos untuk aspek bawaan jika tidak ditemukan di instrumen
const ASPECT_POS_MAP = {
    "Administrasi": "POS_1", "Media Informasi": "POS_1",
    "Aspirasi": "POS_2", "Teknik Sidang": "POS_2",
    "Wawasan": "POS_3", "Kepemimpinan": "POS_3"
};

// Seluruh nama aspek yang ada di Firebase (dinamis, tidak ada hardcode)
let ALL_ASPECTS = [];

// =====================================================================
// 2. INIT & FIREBASE LISTENERS (SINGLE SOURCE OF TRUTH)
// =====================================================================
window.onload = () => {
    seedDemoData();
    ['login-username', 'login-password'].forEach(id =>
        document.getElementById(id).addEventListener('keydown', e => { if (e.key === 'Enter') prosesLogin(); }));
    const saved = sessionStorage.getItem('userSession');
    if (saved) { currentUser = JSON.parse(saved); initDashboard(); }

    db.ref('settings').on('value', snap => {
        if (snap.exists()) {
            sysSettings = snap.val();
            if (!sysSettings.durations) sysSettings.durations = { POS_1: 300, POS_2: 300, POS_3: 300 };
            document.getElementById('sys-status-badge').innerHTML = `<span class="badge" style="background:#0f172a;color:#fff;">Status: ${sysSettings.status}</span>`;
            if (document.getElementById('set-webname')) {
                document.getElementById('set-webname').value = sysSettings.webName || '';
                document.getElementById('set-t1').value = sysSettings.durations.POS_1;
                document.getElementById('set-t2').value = sysSettings.durations.POS_2;
                document.getElementById('set-t3').value = sysSettings.durations.POS_3;
            }
        }
    });

    db.ref('participants').on('value', snap => {
        dbParticipants = snap.val() || {};
        refreshAllViews();
    });

    db.ref('aspectSessions').on('value', snap => {
        dbSessions = snap.val() || {};
        refreshAllViews();
        updateModalDKSDetailIfOpen();
    });

    db.ref('instruments').on('value', snap => {
        dbInstruments = snap.val() || {};
        syncDynamicAspects();
        refreshAllViews();
        if (currentUser?.role === 'DEV') renderDevInstrumenTable();
    });

    db.ref('auditLogs').orderByChild('timestamp').limitToLast(100).on('value', snap => {
        let arr = [];
        snap.forEach(c => { arr.push({ id: c.key, ...c.val() }); });
        auditLogsArray = arr.reverse();
        if (currentUser?.role === 'DEV') filterAuditLog();
    });
};

// ---------- Helper instrumen dinamis ----------
function sanitizeKey(s) { return String(s).replace(/[.$#\[\]\/]/g, '-').trim(); }

function hashKey(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    return 'q_' + (h >>> 0).toString(36);
}

function syncDynamicAspects() {
    const s = new Set();
    Object.values(dbInstruments).forEach(frm => Object.values(frm || {}).forEach(pos => Object.keys(pos || {}).forEach(a => s.add(a))));
    ALL_ASPECTS = Array.from(s);
}

// Daftar aspek (yang punya minimal 1 soal aktif) untuk satu formasi, urut sesuai "Urutan Aspek"
function getAspectList(formasi) {
    const res = [], f = dbInstruments[formasi] || {};
    Object.keys(f).forEach(pos => Object.keys(f[pos] || {}).forEach(asp => {
        const node = f[pos][asp] || {};
        const hasActive = Object.keys(node).some(k => k !== '_meta' && node[k] && node[k].active !== false);
        if (hasActive) res.push({ name: asp, pos, urutan: node._meta?.urutan ?? 99 });
    }));
    return res.sort((a, b) => a.urutan - b.urutan);
}
function getAspectNames(formasi) { return getAspectList(formasi).map(a => a.name); }
function getPosForAspect(formasi, asp) {
    const a = getAspectList(formasi).find(x => x.name === asp);
    return a ? a.pos : (ASPECT_POS_MAP[asp] || null);
}

function refreshAllViews() {
    if (!currentUser) return;
    renderGlobalStats();
    if (currentUser.role === 'PEWAWANCARA' && !currentWorkSession) renderPewawancaraList();
    if (currentUser.role === 'DKS' || currentUser.role === 'DEV') {
        renderDKSLive();
        renderTableRekap();
    }
    if (currentUser.role === 'DEV') renderDevPesertaTable();
}

function formatUrut(num) { return String(num).padStart(3, '0'); }

function getNextUrut() {
    let currentMaxUrut = 0;
    Object.values(dbParticipants).forEach(p => { if (p.urut > currentMaxUrut) currentMaxUrut = p.urut; });
    return currentMaxUrut + 1;
}

// =====================================================================
// 3. AUTHENTICATION
// =====================================================================
function prosesLogin() {
    const u = document.getElementById('login-username').value.trim().toLowerCase();
    const p = document.getElementById('login-password').value;
    if (!u || !p) return showToast("Username dan password wajib diisi", "error");

    db.ref('users').once('value').then(snap => {
        if (!snap.exists()) return showToast("Belum ada akun di database. Muat ulang halaman lalu coba lagi.", "error");
        let found = null; let uId = null; let userAda = false;
        snap.forEach(c => {
            const v = c.val() || {};
            if (String(v.username || '').trim().toLowerCase() === u) {
                userAda = true;
                if (String(v.password) === p) { found = v; uId = c.key; }
            }
        });
        if (!userAda) return showToast("User tidak ditemukan", "error");
        if (!found) return showToast("Password salah", "error");

        const role = String(found.role || '').trim().toUpperCase();
        if (!['DEV', 'DKS', 'PEWAWANCARA'].includes(role)) return showToast(`Role akun tidak valid: "${found.role}"`, "error");

        currentUser = { id: uId, name: found.name, role, posId: found.posId || null };
        sessionStorage.setItem('userSession', JSON.stringify(currentUser));
        writeAudit("LOGIN", "Auth", "User masuk ke sistem", currentUser.name);
        initDashboard();
    }).catch(err => {
        console.error(err);
        showToast("Gagal membaca database: " + err.message + " (cek Firebase Rules)", "error");
    });
}

function prosesLogout() {
    writeAudit("LOGOUT", "Auth", "User keluar", currentUser.name);
    sessionStorage.clear(); window.location.reload();
}

function initDashboard() {
    document.getElementById('view-login').style.display = 'none';
    document.getElementById('view-app').style.display = 'flex';
    document.getElementById('user-display-name').innerText = currentUser.name;
    document.getElementById('user-badge').innerText = currentUser.role;
    document.getElementById('user-badge').className = `badge badge-${currentUser.role.toLowerCase()}`;
    document.querySelectorAll('.nav-menu').forEach(el => el.style.display = 'none');

    if (currentUser.role === 'PEWAWANCARA') {
        document.getElementById('nav-pewawancara').style.display = 'block';
        document.getElementById('btn-tambah-peserta-pew').style.display = 'block';
        switchSection('sec-p-peserta');
    } else if (currentUser.role === 'DKS') {
        document.getElementById('nav-dks').style.display = 'block';
        switchSection('sec-dks-live');
    } else if (currentUser.role === 'DEV') {
        document.getElementById('nav-dev').style.display = 'block';
        switchSection('sec-dks-live');
    }
    refreshAllViews();
}

function switchSection(id) {
    document.querySelectorAll('.content-section').forEach(el => el.classList.remove('active'));
    document.getElementById(id).classList.add('active');
    document.querySelectorAll('.nav-item').forEach(el =>
        el.classList.toggle('active', (el.getAttribute('onclick') || '').includes(`'${id}'`)));
}

// =====================================================================
// 4. CORE LOGIC (STATUS DERIVATION)
// =====================================================================
function getParticipantStatus(pId) {
    const names = getAspectNames(dbParticipants[pId]?.formasi);
    let done = 0, prog = 0;
    names.forEach(asp => {
        const s = dbSessions[`${pId}_${asp}`];
        if (s?.status === 'COMPLETED') done++; else if (s?.status === 'IN_PROGRESS') prog++;
    });
    if (names.length > 0 && done >= names.length) return "COMPLETED";
    if (done > 0) return "PARTIALLY_COMPLETED";
    if (prog > 0) return "IN_PROGRESS";
    return "NOT_STARTED";
}

function getBadgeHtml(status) {
    if (status === 'COMPLETED') return `<span class="badge badge-completed">Selesai</span>`;
    if (status === 'PARTIALLY_COMPLETED') return `<span class="badge badge-partial">Sebagian Selesai</span>`;
    if (status === 'IN_PROGRESS') return `<span class="badge badge-in-progress">Wawancara</span>`;
    return `<span class="badge badge-not-started">Belum Mulai</span>`;
}

// =====================================================================
// 5. GLOBAL STATS
// =====================================================================
function renderGlobalStats() {
    const bar = document.getElementById('global-stats-bar');
    if (!bar) return;
    const participantsArr = Object.values(dbParticipants).filter(p => p.active !== false);

    let kpu = 0, panwas = 0;
    let kelCount = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };

    participantsArr.forEach(p => {
        if (p.formasi === 'KPU') kpu++;
        if (p.formasi === 'PANWAS') panwas++;
        if (kelCount[p.kelompok] !== undefined) kelCount[p.kelompok]++;
    });
    bar.innerHTML = `
        <div class="g-stat-box"><div class="g-stat-title">TOTAL PESERTA</div><div class="g-stat-val">${participantsArr.length}</div></div>
        <div class="g-stat-box"><div class="g-stat-title">KPU / PANWAS</div><div class="g-stat-val" style="color:var(--primary);">${kpu} <span style="font-size:14px;color:#cbd5e1;">/</span> ${panwas}</div></div>
        <div class="g-stat-box"><div class="g-stat-title">Kelompok 1 - 2 - 3</div><div class="g-stat-val" style="font-size:16px;">${kelCount[1]} | ${kelCount[2]} | ${kelCount[3]}</div></div>
        <div class="g-stat-box"><div class="g-stat-title">Kelompok 4 - 5</div><div class="g-stat-val" style="font-size:16px;">${kelCount[4]} | ${kelCount[5]}</div></div>
    `;
}

// =====================================================================
// 6. PEWAWANCARA WORKFLOW
// =====================================================================
function renderPewawancaraList() {
    const tabCont = document.getElementById('tabs-kelompok');
    tabCont.innerHTML = '';
    for (let i = 1; i <= 5; i++) {
        const act = activeTabKelompok == i ? 'active' : '';
        tabCont.innerHTML += `<button class="tab-btn ${act}" onclick="activeTabKelompok='${i}'; renderPewawancaraList();">Kelompok ${i}</button>`;
    }
    const cont = document.getElementById('grid-peserta-pewawancara');
    let scrollPos = cont.scrollTop;
    let html = '';

    let arr = Object.keys(dbParticipants).map(k => ({ id: k, ...dbParticipants[k] })).filter(p => p.active !== false && p.kelompok == activeTabKelompok);
    arr.sort((a, b) => a.urut - b.urut);

    arr.forEach(p => {
        html += `<div class="peserta-card">
            <div style="display:flex; justify-content:space-between;">
                <h4>${formatUrut(p.urut)}. ${p.nama}</h4>
                <div><button class="btn btn-outline btn-sm" onclick="modalFormPeserta('${p.id}')">✏️ Edit</button></div>
            </div>
            <div style="margin-bottom:10px;"><span class="badge" style="background:#e2e8f0; color:#334155">${p.formasi}</span> <span style="font-size:11px;color:var(--text-muted)">NIM: ${p.nim}</span></div>
            <div class="aspek-list">`;

        const aspects = getAspectList(p.formasi);
        if (aspects.length === 0) {
            html += `<div style="font-size:12px; color:var(--text-muted); padding:6px 0;">Belum ada instrumen untuk formasi ${p.formasi}.</div>`;
        }

        aspects.forEach(({ name: asp, pos: requiredPos }) => {
            const sessId = `${p.id}_${asp}`;
            const sess = dbSessions[sessId];
            let badge = `<span style="font-size:10px; color:#64748b; font-weight:600;">AVAILABLE</span>`;
            let btn = `<button class="btn btn-primary btn-sm" onclick="claimAspek('${p.id}', '${asp}', '${requiredPos}')">Mulai</button>`;

            if (sess && sess.status !== 'NOT_STARTED') {
                if (sess.status === 'COMPLETED') {
                    if (sess.interviewerId === currentUser.id) {
                        badge = `<span style="font-size:10px; color:#059669; font-weight:600;">✓ SELESAI (Anda)</span>`;
                        btn = `<button class="btn btn-outline btn-sm" onclick="editAspek('${p.id}', '${asp}')">Review</button>`;
                    } else {
                        badge = `<span style="font-size:10px; color:#059669; font-weight:600;">✓ Selesai oleh ${sess.interviewerName}</span>`;
                        btn = ``;
                    }
                } else if (sess.status === 'IN_PROGRESS') {
                    if (sess.interviewerId === currentUser.id) {
                        badge = `<span style="font-size:10px; color:#d97706; font-weight:600;">⌚ PROSES ANDA</span>`;
                        btn = `<button class="btn btn-warning btn-sm" onclick="bukaWorkroom('${p.id}', '${asp}', false)">Lanjut</button>`;
                    } else {
                        badge = `<span style="font-size:10px; color:#ef4444; font-weight:600;">🔒 LOCKED: ${sess.interviewerName}</span>`;
                        btn = ``;
                    }
                }
            }
            html += `<div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid #f1f5f9; padding:6px 0;">
                <div><div style="font-size:12px; font-weight:600; color:var(--dark);">${asp} <span style="font-weight:400;color:var(--text-muted);">(${requiredPos.replace('_', ' ')})</span></div>${badge}</div>
                <div>${btn}</div>
            </div>`;
        });
        html += `</div></div>`;
    });

    if (arr.length === 0) html = `<div style="grid-column: 1/-1; text-align:center; padding: 40px; color:var(--text-muted);">Tidak ada peserta di Kelompok ${activeTabKelompok}.</div>`;
    cont.innerHTML = html;
    cont.scrollTop = scrollPos;
}

function claimAspek(pId, asp, requiredPos) {
    if (currentUser.posId && currentUser.posId !== requiredPos) {
        return showToast(`Anda tidak dapat meng-claim aspek ini. Ini adalah wewenang ${requiredPos}`, "error");
    }
    const sessId = `${pId}_${asp}`;
    const p = dbParticipants[pId];
    db.ref(`aspectSessions/${sessId}`).transaction(curr => {
        if (curr === null || curr.status === 'NOT_STARTED') {
            return {
                participantId: pId, aspectName: asp, posId: requiredPos, formasi: p.formasi,
                status: 'IN_PROGRESS', interviewerId: currentUser.id, interviewerName: currentUser.name,
                startedAt: firebase.database.ServerValue.TIMESTAMP, scores: {}, notes: "", probing: ""
            };
        }
        return;
    }, (err, comm, snap) => {
        if (err) showToast("Network Error saat claim", "error");
        else if (!comm) showToast("Gagal! Aspek sudah di-claim pewawancara lain.", "warning");
        else {
            writeAudit("CLAIM_ASPECT", "Wawancara", `Klaim peserta ${p.nama} - ${asp}`, p.nama);
            bukaWorkroom(pId, asp, false, snap.val());
        }
    });
}

function editAspek(pId, asp) { isEditMode = true; bukaWorkroom(pId, asp, true, dbSessions[`${pId}_${asp}`]); }

function bukaWorkroom(pId, asp, isEdit, sessionData) {
    const p = dbParticipants[pId];
    if (!sessionData) sessionData = dbSessions[`${pId}_${asp}`];
    currentWorkSession = { pId, aspectName: asp, sessionId: `${pId}_${asp}`, formasi: p.formasi, sessionData };
    isEditMode = isEdit;

    document.getElementById('workroom-subtitle').innerText = `Peserta: ${formatUrut(p.urut)}. ${p.nama} (${p.nim}) | Formasi: ${p.formasi} | Aspek: ${asp}`;
    document.getElementById('mode-edit-badge').style.display = isEdit ? 'inline-block' : 'none';

    document.getElementById('workroom-catatan').value = sessionData?.notes || "";
    document.getElementById('workroom-probing').value = sessionData?.probing || "";

    let requiredPos = sessionData?.posId || getPosForAspect(p.formasi, asp);
    let qs = dbInstruments[p.formasi]?.[requiredPos]?.[asp] || {};
    let html = '';
    Object.keys(qs).filter(k => k !== '_meta').sort((a, b) => (qs[a]?.order || 99) - (qs[b]?.order || 99)).forEach(qId => {
        const q = qs[qId];
        if (q.active === false && !isEdit) return;
        const val = sessionData?.scores ? (sessionData.scores[qId] || '') : '';
        html += `<div class="form-group" style="background:#f8fafc; padding:15px; border-radius:6px; border:1px solid var(--border);">
            <label style="font-size:14px;"><span style="color:var(--primary)">[Indikator: ${q.indikator}]</span><br>${q.pertanyaan}</label>
            <div style="display:flex; align-items:center; gap:10px;">
                <input type="number" id="skor_${qId}" class="form-control" style="width:100px; font-weight:bold; font-size:16px; text-align:center;" min="1" max="${q.nilaiMax || 10}" placeholder="1 - ${q.nilaiMax || 10}" value="${val}">
                <span style="font-size:12px; color:var(--text-muted)">Range: 1 - ${q.nilaiMax || 10}</span>
            </div>
        </div>`;
    });
    if (html === '') html = '<div class="alert alert-warning">Belum ada pertanyaan aktif untuk aspek ini.</div>';
    document.getElementById('form-instrumen-container').innerHTML = html;

    switchSection('sec-p-workroom');

    clearInterval(timerInterval);
    if (!isEdit) {
        const dur = sysSettings.durations[requiredPos] || 300;
        const start = sessionData?.startedAt || Date.now();

        timerInterval = setInterval(() => {
            const elapsed = Math.floor((Date.now() - start) / 1000);
            let rem = dur - elapsed;
            const tb = document.getElementById('workroom-timer');
            if (rem <= 0) {
                tb.innerText = "WAKTU HABIS";
                tb.classList.add('danger');
                clearInterval(timerInterval);
                return;
            }
            tb.innerText = `${String(Math.floor(rem / 60)).padStart(2, '0')}:${String(rem % 60).padStart(2, '0')}`;
            if (rem <= 60) tb.classList.add('danger'); else tb.classList.remove('danger');
        }, 1000);
    } else {
        document.getElementById('workroom-timer').innerText = "REVIEW";
        document.getElementById('workroom-timer').classList.remove('danger');
    }
}

function konfirmasiSelesaiAspek() {
    let scores = {}; let isLengkap = true;
    let oldScores = isEditMode ? currentWorkSession.sessionData?.scores : null;

    let requiredPos = currentWorkSession.sessionData?.posId || getPosForAspect(currentWorkSession.formasi, currentWorkSession.aspectName);
    const qs = dbInstruments[currentWorkSession.formasi]?.[requiredPos]?.[currentWorkSession.aspectName] || {};
    document.querySelectorAll('input[id^="skor_"]').forEach(inp => {
        let v = parseInt(inp.value);
        let qId = inp.id.replace('skor_', '');
        let max = qs[qId]?.nilaiMax || 10;
        if (isNaN(v) || v < 1 || v > max) isLengkap = false;
        scores[qId] = v;
    });

    if (!isLengkap && Object.keys(scores).length > 0) return showToast("Semua skor harus diisi sesuai range!", "error");
    const notes = document.getElementById('workroom-catatan').value.trim();
    if (!notes) return showToast("Catatan umum wajib diisi!", "error");
    const probing = document.getElementById('workroom-probing').value.trim();
    const sessRef = db.ref(`aspectSessions/${currentWorkSession.sessionId}`);
    const act = isEditMode ? "EDIT_SCORE" : "COMPLETE_ASPECT";
    const pNama = dbParticipants[currentWorkSession.pId].nama;

    sessRef.update({
        scores, notes, probing,
        status: 'COMPLETED',
        completedAt: firebase.database.ServerValue.TIMESTAMP
    }).then(() => {
        writeAudit(act, "Wawancara", `Menyimpan nilai ${currentWorkSession.aspectName}`, pNama, JSON.stringify(oldScores), JSON.stringify(scores));

        const names = getAspectNames(currentWorkSession.formasi);
        let compCount = 1;
        names.forEach(asp => {
            if (asp !== currentWorkSession.aspectName && dbSessions[`${currentWorkSession.pId}_${asp}`]?.status === 'COMPLETED') compCount++;
        });
        db.ref(`participants/${currentWorkSession.pId}`).update({
            globalStatus: compCount >= names.length ? 'COMPLETED' : 'PARTIALLY_COMPLETED'
        });
        keluarWorkroom();
        showToast("Aspek berhasil diselesaikan!", "success");
    });
}

function keluarWorkroom() {
    currentWorkSession = null;
    clearInterval(timerInterval);
    switchSection('sec-p-peserta');
    refreshAllViews();
}

// =====================================================================
// 7. EXCEL PARSER & IMPORT SYSTEM (DEV ONLY)
// =====================================================================
function downloadTemplate(type) {
    let wb = XLSX.utils.book_new();
    let ws_data = []; let ws_petunjuk = [];
    let filename = "";

    if (type === 'PESERTA') {
        ws_data = [
            ["No", "Nama", "NIM", "Formasi", "Kelompok"],
            [1, "Ahmad Fikri", "2301001", "KPU", 1],
            [2, "Bima Pratama", "2301002", "PANWAS", 1]
        ];
        ws_petunjuk = [
            ["PANDUAN PENGISIAN TEMPLATE PESERTA"],
            ["Kolom", "Keterangan"],
            ["No", "Diisi nomor urut peserta (Angka). Kosongkan jika ingin sistem urutkan otomatis."],
            ["Nama", "Wajib diisi dengan nama lengkap peserta."],
            ["NIM", "Wajib diisi dengan NIM peserta tanpa spasi."],
            ["Formasi", "Hanya ketik: KPU atau PANWAS"],
            ["Kelompok", "Hanya angka (Contoh: 1, 2, 3, 4, 5)"]
        ];
        filename = "template_peserta_pemira_2026.xlsx";
    } else if (type === 'INSTRUMEN') {
        ws_data = [
            ["No", "Formasi", "Pos", "Aspek", "Deskripsi Aspek", "Urutan Aspek", "Indikator", "Pertanyaan", "Nilai Maksimal", "Urutan Pertanyaan", "Status"],
            [1, "KPU", "Pos 1", "Administrasi", "Kemampuan administrasi", 1, "Ketelitian memeriksa data", "Jika kamu menemukan data yang tidak lengkap, apa yang kamu lakukan?", 10, 1, "ACTIVE"],
            [2, "KPU", "Pos 1", "Administrasi", "Kemampuan administrasi", 1, "Menentukan prioritas", "Jika ada beberapa tugas bersamaan, apa prioritasmu?", 10, 2, "ACTIVE"],
            [3, "PANWAS", "Pos 3", "Integritas", "Ketahanan mental panwas", 2, "Kejujuran", "Bagaimana Anda menanggapi suap?", 10, 1, "ACTIVE"]
        ];
        ws_petunjuk = [
            ["PANDUAN PENGISIAN TEMPLATE INSTRUMEN (ASPEK + SOAL GABUNG)"],
            ["Kolom", "Keterangan"],
            ["No", "Nomor baris sekedar referensi (bebas)."],
            ["Formasi", "Wajib diisi: KPU atau PANWAS"],
            ["Pos", "Wajib diisi Format: Pos 1 / Pos 2 / Pos 3"],
            ["Aspek", "Nama aspek utama. Jika diulang di baris bawahnya, sistem akan menggabungkannya sebagai pertanyaan di dalam aspek yang sama."],
            ["Deskripsi Aspek", "Deskripsi untuk aspek tersebut (Opsional)."],
            ["Urutan Aspek", "Nomor urut tampil aspek di layar."],
            ["Indikator", "Wajib diisi: Indikator penilaian dari soal ini."],
            ["Pertanyaan", "Wajib diisi: Kalimat pertanyaan untuk pewawancara."],
            ["Nilai Maksimal", "Wajib berupa angka (Misal: 10)."],
            ["Urutan Pertanyaan", "Urutan tampil pertanyaan dalam satu aspek (Angka)."],
            ["Status", "ACTIVE atau NONACTIVE"]
        ];
        filename = "template_instrumen_pemira_2026.xlsx";
    }

    let ws = XLSX.utils.aoa_to_sheet(ws_data);
    let wsp = XLSX.utils.aoa_to_sheet(ws_petunjuk);
    XLSX.utils.book_append_sheet(wb, ws, type === 'PESERTA' ? "Peserta" : "Instrumen");
    XLSX.utils.book_append_sheet(wb, wsp, "Petunjuk");
    XLSX.writeFile(wb, filename);
}

function processExcel(e, type) {
    if (currentUser.role !== 'DEV') return showToast("Akses Ditolak", "error");

    const file = e.target.files[0];
    if (!file) return;
    activeExcelType = type;

    const reader = new FileReader();
    reader.onload = function (evt) {
        try {
            const data = new Uint8Array(evt.target.result);
            const workbook = XLSX.read(data, { type: 'array' });
            const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
            const rows = XLSX.utils.sheet_to_json(firstSheet, { header: 1 });

            parsedExcelData = [];
            let validCount = 0; let errorCount = 0;

            let currentMaxUrut = getNextUrut() - 1;
            let currentNims = new Set(Object.values(dbParticipants).filter(p => p.active !== false).map(p => String(p.nim)));

            for (let i = 1; i < rows.length; i++) {
                let r = rows[i];
                if (!r || r.length === 0) continue;
                let errs = [];
                let rowData = {};

                if (type === 'PESERTA') {
                    let urut = parseInt(r[0]);
                    if (isNaN(urut)) { currentMaxUrut++; urut = currentMaxUrut; }

                    let nama = r[1] ? String(r[1]).trim() : '';
                    let nim = r[2] ? String(r[2]).trim() : '';
                    let formasi = r[3] ? String(r[3]).trim().toUpperCase() : '';
                    let kelompok = parseInt(r[4]);

                    if (!nama) errs.push("Nama kosong");
                    if (!nim) errs.push("NIM kosong");
                    if (formasi !== 'KPU' && formasi !== 'PANWAS') errs.push(`Formasi tidak valid: "${formasi}"`);
                    if (isNaN(kelompok) || kelompok < 1) errs.push("Kelompok harus angka");

                    if (currentNims.has(nim)) errs.push(`NIM ${nim} sudah terdaftar`);
                    if (errs.length === 0) currentNims.add(nim);

                    rowData = { rowNum: i + 1, urut, nama, nim, formasi, kelompok };
                }
                else if (type === 'INSTRUMEN') {
                    let formasi = r[1] ? String(r[1]).trim().toUpperCase() : '';
                    let posText = r[2] ? String(r[2]).trim().toUpperCase() : '';
                    let aspek = r[3] ? sanitizeKey(r[3]) : '';
                    let deskripsi = r[4] ? String(r[4]).trim() : '';
                    let urutAspek = parseInt(r[5]) || 99;
                    let indikator = r[6] ? String(r[6]).trim() : '';
                    let pertanyaan = r[7] ? String(r[7]).trim() : '';
                    let maxVal = parseInt(r[8]);
                    let urutQ = parseInt(r[9]) || 99;
                    let statusStr = r[10] ? String(r[10]).trim().toUpperCase() : 'ACTIVE';

                    let pos = posText.replace(/[^0-9]/g, ''); pos = pos ? 'POS_' + pos : '';

                    if (formasi !== 'KPU' && formasi !== 'PANWAS') errs.push(`Formasi tidak valid: "${formasi}"`);
                    if (!pos.match(/^POS_[123]$/)) errs.push(`Pos tidak dikenali: "${posText}"`);
                    if (!aspek) errs.push("Aspek kosong");
                    if (!indikator) errs.push("Indikator kosong");
                    if (!pertanyaan) errs.push("Pertanyaan kosong");
                    if (isNaN(maxVal) || maxVal <= 0) errs.push("Nilai Maksimal harus angka positif");

                    rowData = {
                        rowNum: i + 1, formasi, pos, aspek, deskripsi, urutAspek,
                        indikator, pertanyaan, nilaiMax: maxVal, order: urutQ, active: statusStr === 'ACTIVE' || statusStr === 'AKTIF'
                    };
                }

                if (errs.length === 0) validCount++; else errorCount++;
                parsedExcelData.push({ ...rowData, status: errs.length === 0 ? 'VALID' : errs.join(' | ') });
            }

            renderPreviewModal(type, validCount, errorCount);
        } catch (err) {
            showToast("Gagal memproses Excel. Pastikan format sesuai template.", "error");
            console.error(err);
        }
        e.target.value = '';
    };
    reader.readAsArrayBuffer(file);
}

function renderPreviewModal(type, valid, errCount) {
    document.getElementById('preview-title').innerText = `Preview Import ${type}`;

    const summaryDiv = document.getElementById('preview-summary');
    const thead = document.getElementById('preview-thead');
    const tbody = document.getElementById('preview-tbody');
    thead.innerHTML = ''; tbody.innerHTML = '';

    if (type === 'PESERTA') {
        summaryDiv.innerHTML = `<div>Total Baris: ${parsedExcelData.length}</div> <div><span style="color:var(--success)">✓ Valid: ${valid}</span></div> <div><span style="color:var(--danger)">⚠ Error (Dilewati): ${errCount}</span></div>`;
        thead.innerHTML = `<th>Baris</th><th>No Urut</th><th>Nama</th><th>NIM</th><th>Formasi</th><th>Kelompok</th><th>Status Validasi</th>`;
        parsedExcelData.forEach(d => {
            let sCol = d.status === 'VALID' ? 'color:var(--success);font-weight:bold;' : 'color:var(--danger);';
            tbody.innerHTML += `<tr><td>${d.rowNum}</td><td>${formatUrut(d.urut)}</td><td>${d.nama}</td><td>${d.nim}</td><td>${d.formasi}</td><td>${d.kelompok}</td><td style="${sCol}">${d.status}</td></tr>`;
        });
    } else if (type === 'INSTRUMEN') {
        let fKpu = 0, fPanwas = 0, uniqueAspects = new Set();
        parsedExcelData.forEach(d => {
            if (d.status === 'VALID') {
                if (d.formasi === 'KPU') fKpu++; else fPanwas++;
                uniqueAspects.add(`${d.formasi}_${d.pos}_${d.aspek}`);
            }
        });

        summaryDiv.innerHTML = `
            <div>Total Baris (Soal): ${parsedExcelData.length}</div>
            <div>Aspek Unik Baru/Update: ${uniqueAspects.size}</div>
            <div>Formasi KPU: ${fKpu} Soal</div>
            <div>Formasi PANWAS: ${fPanwas} Soal</div>
            <div><span style="color:var(--success)">✓ Data Valid: ${valid}</span></div>
            <div><span style="color:var(--danger)">⚠ Data Error: ${errCount}</span></div>
        `;

        thead.innerHTML = `<th>Baris</th><th>Formasi/Pos/Aspek</th><th>Indikator</th><th>Pertanyaan</th><th>Max</th><th>Validasi</th>`;
        parsedExcelData.forEach(d => {
            let sCol = d.status === 'VALID' ? 'color:var(--success);' : 'color:var(--danger);';
            tbody.innerHTML += `<tr>
                <td>${d.rowNum}</td>
                <td><span class="badge" style="background:#f1f5f9;color:#000;">${d.formasi} - ${d.pos}</span> <br><b>${d.aspek}</b></td>
                <td>${d.indikator}</td><td>${d.pertanyaan}</td><td>${d.nilaiMax}</td>
                <td style="${sCol}">${d.status}</td>
            </tr>`;
        });
    }

    const btnExe = document.getElementById('btn-execute-import');
    btnExe.onclick = () => executeExcelImport(type);
    btnExe.disabled = (valid === 0);
    document.getElementById('modal-preview').style.display = 'flex';
}

function executeExcelImport(type) {
    let updates = {};
    let count = 0;

    parsedExcelData.forEach(d => {
        if (d.status !== 'VALID') return;

        if (type === 'PESERTA') {
            let newId = "p_" + Date.now() + "_" + count;
            updates[`participants/${newId}`] = {
                urut: d.urut, nama: d.nama, nim: d.nim,
                formasi: d.formasi, kelompok: d.kelompok,
                active: true, globalStatus: "NOT_STARTED"
            };
            count++;
        }
        else if (type === 'INSTRUMEN') {
            updates[`instruments/${d.formasi}/${d.pos}/${d.aspek}/_meta`] = {
                deskripsi: d.deskripsi, urutan: d.urutAspek, active: true
            };
            // ID deterministik: import ulang tidak menggandakan soal
            let qId = hashKey(`${d.formasi}|${d.pos}|${d.aspek}|${d.pertanyaan}`);
            updates[`instruments/${d.formasi}/${d.pos}/${d.aspek}/${qId}`] = {
                indikator: d.indikator, pertanyaan: d.pertanyaan,
                nilaiMax: d.nilaiMax, order: d.order, active: d.active
            };
            count++;
        }
    });

    if (count === 0) return showToast("Tidak ada data valid untuk diimport", "error");

    document.getElementById('btn-execute-import').innerText = 'Memproses...';
    document.getElementById('btn-execute-import').disabled = true;

    db.ref().update(updates).then(() => {
        document.getElementById('modal-preview').style.display = 'none';
        document.getElementById('btn-execute-import').innerText = 'Import Data Valid ke Firebase';

        showToast(`IMPORT BERHASIL! ${count} data diproses.`, "success");
        writeAudit(`IMPORT_${type}_EXCEL`, type, `Import ${count} baris valid via Excel (Additive)`);
    }).catch(err => {
        showToast("Error update Database", "error");
        console.error(err);
        document.getElementById('btn-execute-import').innerText = 'Import Data Valid ke Firebase';
        document.getElementById('btn-execute-import').disabled = false;
    });
}

// =====================================================================
// 8. CRUD MANUAL PESERTA & INSTRUMEN
// =====================================================================
function modalFormPeserta(pId) {
    const p = pId ? dbParticipants[pId] : null;
    let nextUrut = getNextUrut();

    let isDev = currentUser.role === 'DEV';
    let urutHtml = isDev ?
        `<div class="form-group"><label>Nomor Peserta (Auto / Manual)</label><input type="number" id="f-urut" class="form-control" value="${p?.urut || nextUrut}"></div>`
        :
        `<input type="hidden" id="f-urut" value="${p?.urut || nextUrut}">
         <div class="alert alert-info" style="font-size:12px; margin-bottom:15px; background:#e0f2fe; padding:10px; border-radius:6px; border:1px solid #bae6fd;">Nomor Peserta digenerate otomatis oleh sistem.</div>`;

    tampilkanModal(p ? "Edit Data Peserta" : "Tambah Peserta Manual", `
        ${urutHtml}
        <div class="form-group"><label>Nama Lengkap</label><input type="text" id="f-nama" class="form-control" value="${p?.nama || ''}"></div>
        <div class="form-group"><label>NIM</label><input type="text" id="f-nim" class="form-control" value="${p?.nim || ''}"></div>
        <div class="form-group"><label>Formasi</label><select id="f-formasi" class="form-control"><option value="KPU" ${p?.formasi === 'KPU' ? 'selected' : ''}>KPU</option><option value="PANWAS" ${p?.formasi === 'PANWAS' ? 'selected' : ''}>PANWAS</option></select></div>
        <div class="form-group"><label>Kelompok (1-5)</label><select id="f-kelompok" class="form-control"><option value="1" ${p?.kelompok == 1 ? 'selected' : ''}>Kelompok 1</option><option value="2" ${p?.kelompok == 2 ? 'selected' : ''}>Kelompok 2</option><option value="3" ${p?.kelompok == 3 ? 'selected' : ''}>Kelompok 3</option><option value="4" ${p?.kelompok == 4 ? 'selected' : ''}>Kelompok 4</option><option value="5" ${p?.kelompok == 5 ? 'selected' : ''}>Kelompok 5</option></select></div>
    `, false, () => {
        const urut = parseInt(document.getElementById('f-urut').value);
        const nama = document.getElementById('f-nama').value.trim();
        const nim = document.getElementById('f-nim').value.trim();
        const formasi = document.getElementById('f-formasi').value;
        const kelompok = parseInt(document.getElementById('f-kelompok').value);

        if (!nama || !nim || isNaN(urut)) return showToast("Data wajib diisi lengkap!", "error");

        if (pId) {
            db.ref(`participants/${pId}`).update({ urut, nama, nim, formasi, kelompok }).then(() => {
                showToast("Peserta diperbarui", "success");
                writeAudit("EDIT_PARTICIPANT", "Peserta", `Mengedit data ${nama}`);
            });
        } else {
            let safeUrut = isDev ? urut : getNextUrut();
            const newId = "p_man_" + Date.now();

            db.ref(`participants/${newId}`).set({
                urut: safeUrut, nama, nim, formasi, kelompok, active: true, globalStatus: 'NOT_STARTED'
            }).then(() => {
                showToast("Peserta baru berhasil ditambahkan", "success");
                let auditAction = isDev ? "ADD_PESERTA_MANUAL_DEV" : "ADD_PESERTA_MANUAL_INTERVIEWER";
                writeAudit(auditAction, "Peserta", `Menambah peserta manual: ${nama}`);
            });
        }
    });
}

function hapusPesertaSatu(pId) {
    if (currentUser.role !== 'DEV') return showToast("Hanya DEV yang bisa menghapus", "error");
    const p = dbParticipants[pId];
    tampilkanModal("Hapus Peserta", `Yakin menonaktifkan <b>${p.nama}</b> (Soft Delete)?`, false, () => {
        db.ref(`participants/${pId}`).update({ active: false }).then(() => {
            showToast("Peserta dihapus", "success");
            writeAudit("DELETE_PARTICIPANT", "Peserta", "Soft delete", p.nama);
        });
    });
}

function renderDevPesertaTable() {
    const tbody = document.querySelector('#table-dev-peserta tbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    const q = document.getElementById('dev-peserta-search').value.toLowerCase();

    let arr = Object.keys(dbParticipants).map(k => ({ id: k, ...dbParticipants[k] })).filter(p => p.active !== false);
    arr.sort((a, b) => a.urut - b.urut);

    arr.forEach(p => {
        if (q && !(String(p.nama || "").toLowerCase().includes(q) || String(p.nim || "").toLowerCase().includes(q))) return;
        tbody.innerHTML += `<tr>
            <td style="font-family: monospace; font-size:14px; font-weight:bold;">${formatUrut(p.urut)}</td>
            <td><b>${p.nama}</b></td><td>${p.nim}</td>
            <td><span class="badge" style="background:#e2e8f0;color:#000">${p.formasi}</span></td>
            <td>Kel ${p.kelompok}</td>
            <td>
                <button class="btn btn-outline btn-sm" onclick="modalFormPeserta('${p.id}')">✏️</button>
                <button class="btn btn-danger btn-sm" onclick="hapusPesertaSatu('${p.id}')">🗑️</button>
            </td>
        </tr>`;
    });
}

function modalTambahAspekManual() {
    if (currentUser.role !== 'DEV') return;
    tampilkanModal("Tambah Aspek Baru (Manual)", `
        <div class="form-group"><label>Nama Aspek</label><input type="text" id="ma-nama" class="form-control" placeholder="Contoh: Integritas"></div>
        <div class="form-group"><label>Formasi</label><select id="ma-frm" class="form-control"><option value="KPU">KPU</option><option value="PANWAS">PANWAS</option></select></div>
        <div class="form-group"><label>Pos</label><select id="ma-pos" class="form-control"><option value="POS_1">Pos 1</option><option value="POS_2">Pos 2</option><option value="POS_3">Pos 3</option></select></div>
        <div class="form-group"><label>Deskripsi (Opsional)</label><input type="text" id="ma-desc" class="form-control"></div>
        <div class="form-group"><label>Urutan Tampil</label><input type="number" id="ma-urut" class="form-control" value="99"></div>
    `, false, () => {
        const asp = sanitizeKey(document.getElementById('ma-nama').value);
        const frm = document.getElementById('ma-frm').value;
        const pos = document.getElementById('ma-pos').value;
        const desc = document.getElementById('ma-desc').value.trim();
        const urut = parseInt(document.getElementById('ma-urut').value) || 99;

        if (!asp) return showToast("Nama aspek wajib", "error");

        db.ref(`instruments/${frm}/${pos}/${asp}/_meta`).set({ deskripsi: desc, urutan: urut, active: true }).then(() => {
            showToast("Aspek berhasil dibuat. Tambahkan minimal 1 soal agar tampil di Pewawancara.", "success");
            writeAudit("ADD_ASPEK_MANUAL", "Instrumen", `Tambah Aspek Manual: ${asp}`);
        });
    });
}

function modalTambahPertanyaanManual() {
    if (currentUser.role !== 'DEV') return;
    tampilkanModal("Tambah Pertanyaan (Manual)", `
        <div class="form-group"><label>Formasi</label><select id="mi-frm" class="form-control" onchange="updateDropdownAspek()"><option value="KPU">KPU</option><option value="PANWAS">PANWAS</option></select></div>
        <div class="form-group"><label>Pos</label><select id="mi-pos" class="form-control" onchange="updateDropdownAspek()"><option value="POS_1">Pos 1</option><option value="POS_2">Pos 2</option><option value="POS_3">Pos 3</option></select></div>
        <div class="form-group"><label>Aspek Wawancara (Dinamis dari Firebase)</label><select id="mi-asp" class="form-control"></select></div>
        <div class="form-group"><label>Indikator Penilaian</label><input type="text" id="mi-ind" class="form-control" placeholder="Contoh: Ketelitian"></div>
        <div class="form-group"><label>Pertanyaan</label><textarea id="mi-q" class="form-control" rows="3"></textarea></div>
        <div style="display:flex; gap:10px;">
            <div class="form-group" style="flex:1"><label>Nilai Maks</label><input type="number" id="mi-max" class="form-control" value="10"></div>
            <div class="form-group" style="flex:1"><label>Urutan Soal</label><input type="number" id="mi-urut" class="form-control" value="99"></div>
        </div>
    `, false, () => {
        const frm = document.getElementById('mi-frm').value;
        const pos = document.getElementById('mi-pos').value;
        const asp = document.getElementById('mi-asp').value;
        const ind = document.getElementById('mi-ind').value.trim();
        const txt = document.getElementById('mi-q').value.trim();
        const max = parseInt(document.getElementById('mi-max').value);
        const urut = parseInt(document.getElementById('mi-urut').value) || 99;

        if (!asp || !ind || !txt) return showToast("Harap lengkapi semua field", "error");

        const qId = "q_" + Date.now();
        db.ref(`instruments/${frm}/${pos}/${asp}/${qId}`).set({
            indikator: ind, pertanyaan: txt, nilaiMax: max || 10, order: urut, active: true
        }).then(() => {
            showToast("Pertanyaan ditambahkan", "success");
            writeAudit("ADD_PERTANYAAN_MANUAL", "Instrumen", `Soal baru pd Aspek ${asp}`);
        });
    });
    updateDropdownAspek();
}

function updateDropdownAspek() {
    const frm = document.getElementById('mi-frm')?.value;
    const pos = document.getElementById('mi-pos')?.value;
    const aspSel = document.getElementById('mi-asp');
    if (!frm || !pos || !aspSel) return;

    aspSel.innerHTML = '';
    const aspects = Object.keys(dbInstruments[frm]?.[pos] || {});
    if (aspects.length === 0) {
        aspSel.innerHTML = '<option value="">-- Belum ada Aspek. Buat Aspek Manual dulu --</option>';
    } else {
        aspects.forEach(a => { aspSel.innerHTML += `<option value="${a}">${a}</option>`; });
    }
}

// =====================================================================
// 9. DKS / DEV MONITORING & REKAP
// =====================================================================
function renderDKSLive() {
    const tbody = document.querySelector('#table-live-monitoring tbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    const q = document.getElementById('live-search')?.value.toLowerCase() || '';
    const filterStat = document.getElementById('live-filter-stat')?.value || 'ALL';
    let inprog = 0, part = 0, sel = 0;
    let arr = Object.keys(dbParticipants).map(k => ({ id: k, ...dbParticipants[k] })).filter(p => p.active !== false);
    arr.sort((a, b) => a.urut - b.urut);
    arr.forEach(p => {
        let activeAspekText = [];
        let pStatus = getParticipantStatus(p.id);

        if (pStatus === 'IN_PROGRESS') inprog++;
        if (pStatus === 'PARTIALLY_COMPLETED') part++;
        if (pStatus === 'COMPLETED') sel++;
        if (filterStat !== 'ALL' && pStatus !== filterStat) return;
        if (q && !(String(p.nama || "").toLowerCase().includes(q) || String(p.nim || "").toLowerCase().includes(q))) return;
        getAspectNames(p.formasi).forEach(asp => {
            const s = dbSessions[`${p.id}_${asp}`];
            if (s && s.status === 'IN_PROGRESS') activeAspekText.push(`<span style="color:#d97706;font-size:11px;font-weight:600;">${asp} (oleh ${s.interviewerName})</span>`);
            if (s && s.status === 'COMPLETED') activeAspekText.push(`<span style="color:#059669;font-size:11px;">✓ ${asp}</span>`);
        });
        let displayAspek = activeAspekText.length > 0 ? activeAspekText.join('<br>') : `<span style="color:var(--text-muted);font-size:11px;">Belum ada progress</span>`;
        tbody.innerHTML += `<tr>
            <td>${formatUrut(p.urut)}</td>
            <td><b>${p.nama}</b><br><span style="font-size:10px">${p.nim}</span></td>
            <td><span class="badge" style="background:#e2e8f0;color:#000">${p.formasi}</span><br><span style="font-size:10px">Kel ${p.kelompok}</span></td>
            <td>${displayAspek}</td>
            <td>${getBadgeHtml(pStatus)}</td>
            <td><button class="btn btn-outline btn-sm" onclick="openDKSDetail('${p.id}')">🔍 Detail</button></td>
        </tr>`;
    });

    if (document.getElementById('stat-progress')) document.getElementById('stat-progress').innerText = inprog;
    if (document.getElementById('stat-partial')) document.getElementById('stat-partial').innerText = part;
    if (document.getElementById('stat-selesai')) document.getElementById('stat-selesai').innerText = sel;
}

function openDKSDetail(pId) { updateModalDKSDetailIfOpen(pId); document.getElementById('modal-dks-detail').style.display = 'flex'; }
function updateModalDKSDetailIfOpen(forceId = null) {
    const pId = forceId || document.getElementById('modal-dks-detail').dataset.pid;
    if (!pId || document.getElementById('modal-dks-detail').style.display === 'none') return;

    document.getElementById('modal-dks-detail').dataset.pid = pId;
    const p = dbParticipants[pId];
    if (!p) return;
    const cont = document.getElementById('dks-detail-content');

    let html = `<div style="display:flex; gap:20px; background:#f8fafc; padding:15px; border-radius:6px; margin-bottom:15px; border:1px solid var(--border);">
        <div><b>No:</b> ${formatUrut(p.urut)}</div><div><b>Nama:</b> ${p.nama}</div><div><b>NIM:</b> ${p.nim}</div><div><b>Formasi:</b> ${p.formasi}</div>
    </div>`;
    getAspectNames(p.formasi).forEach(asp => {
        const s = dbSessions[`${pId}_${asp}`];
        const status = s?.status || 'NOT_STARTED';
        let statBadge = getBadgeHtml(status);
        let skorDetail = "-"; let note = "-"; let prob = "-"; let pew = "-"; let waktu = "-";

        if (status !== 'NOT_STARTED') {
            pew = s.interviewerName; note = s.notes || "-"; prob = s.probing || "-";
            if (s.startedAt) {
                let startStr = new Date(s.startedAt).toLocaleTimeString('id-ID');
                let endStr = s.completedAt ? new Date(s.completedAt).toLocaleTimeString('id-ID') : '...';
                waktu = `${startStr} - ${endStr}`;
            }
            if (s.scores) {
                let t = 0; Object.values(s.scores).forEach(v => t += v);
                skorDetail = `<b>${t}</b>`;
            }
        }
        html += `<div style="border:1px solid #e2e8f0; padding:12px; border-radius:6px; margin-bottom:10px; background:#fff;">
            <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px dashed #e2e8f0; padding-bottom:8px; margin-bottom:8px;">
                <b style="font-size:14px; color:var(--dark);">${asp}</b>
                <div style="display:flex; gap:15px; align-items:center;">
                    <span style="font-size:12px;color:var(--text-muted)">Skor: ${skorDetail}</span> ${statBadge}
                </div>
            </div>
            <div style="display:grid; grid-template-columns: 1fr 1fr; gap:10px; font-size:12px; color:var(--text-main);">
                <div><b>Pewawancara:</b> ${pew}</div><div><b>Waktu:</b> ${waktu}</div>
                <div style="grid-column:1/-1;"><b>Catatan:</b> ${note}</div>
                <div style="grid-column:1/-1; color:var(--text-muted);"><b>Probing:</b> ${prob}</div>
            </div>
        </div>`;
    });
    cont.innerHTML = html;
}

function renderTableRekap() {
    const tbody = document.querySelector('#table-rekap tbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    const q = document.getElementById('rekap-search').value.toLowerCase();
    const fF = document.getElementById('rekap-filter-formasi').value;
    const sort = document.getElementById('rekap-sort').value;
    let dt = Object.keys(dbParticipants).map(k => ({ id: k, ...dbParticipants[k] })).filter(p => p.active !== false);
    if (fF !== 'ALL') dt = dt.filter(p => p.formasi === fF);
    if (q) dt = dt.filter(p => String(p.nama || "").toLowerCase().includes(q) || String(p.nim || "").toLowerCase().includes(q));
    dt.forEach(p => {
        p.scores = { Administrasi: "-", "Media Informasi": "-", Aspirasi: "-", "Teknik Sidang": "-", Wawasan: "-", Kepemimpinan: "-" };
        p.pos = { POS_1: "-", POS_2: "-", POS_3: "-" }; p.grand = "-";

        let localGrand = 0; let hasData = false;
        getAspectNames(p.formasi).forEach(asp => {
            const s = dbSessions[`${p.id}_${asp}`];
            if (s && s.status === 'COMPLETED' && s.scores) {
                hasData = true;
                let t = 0; Object.values(s.scores).forEach(v => t += v);
                p.scores[asp] = t;
                const posId = s.posId || getPosForAspect(p.formasi, asp);
                if (posId) p.pos[posId] = (p.pos[posId] === "-" ? 0 : p.pos[posId]) + t;
                localGrand += t;
            }
        });
        if (hasData) p.grand = localGrand;
        p.pStatus = getParticipantStatus(p.id);
    });
    if (sort === 'urut_asc') dt.sort((a, b) => a.urut - b.urut);
    if (sort === 'nilai_desc') dt.sort((a, b) => (b.grand === '-' ? -1 : b.grand) - (a.grand === '-' ? -1 : a.grand));
    if (sort === 'nilai_asc') dt.sort((a, b) => (a.grand === '-' ? 9999 : a.grand) - (b.grand === '-' ? 9999 : b.grand));
    if (sort === 'nama_asc') dt.sort((a, b) => a.nama.localeCompare(b.nama));
    let maxSc = calculateMaxScore();
    dt.forEach(p => {
        tbody.innerHTML += `<tr>
            <td>${formatUrut(p.urut)}</td><td><b>${p.nama}</b></td><td>${p.nim}</td><td>${p.formasi}</td><td>${p.kelompok}</td>
            <td>${p.scores['Administrasi']}</td><td>${p.scores['Media Informasi']}</td>
            <td>${p.scores['Aspirasi']}</td><td>${p.scores['Teknik Sidang']}</td>
            <td>${p.scores['Wawasan']}</td><td>${p.scores['Kepemimpinan']}</td>
            <td style="background:#f8fafc; font-weight:600;">${p.pos.POS_1}</td><td style="background:#f8fafc; font-weight:600;">${p.pos.POS_2}</td><td style="background:#f8fafc; font-weight:600;">${p.pos.POS_3}</td>
            <td style="font-weight:bold; font-size:16px; color:var(--primary);">${p.grand}</td>
            <td style="color:var(--text-muted); font-size:11px;">${maxSc[p.formasi]}</td>
            <td>${getBadgeHtml(p.pStatus)}</td>
        </tr>`;
    });
}

function calculateMaxScore() {
    const res = { KPU: 0, PANWAS: 0 };
    ["KPU", "PANWAS"].forEach(frm => {
        Object.values(dbInstruments[frm] || {}).forEach(pos => Object.values(pos).forEach(asp =>
            Object.entries(asp).forEach(([k, q]) => { if (k !== '_meta' && q.active !== false) res[frm] += (q.nilaiMax || 10); })));
    });
    return res;
}

// Export Rekap Tools
function exportExcelRekap() {
    let htmlTable = document.getElementById("table-rekap"); let text = "";
    for (let i = 0; i < htmlTable.rows.length; i++) {
        let rowData = [];
        for (let j = 0; j < htmlTable.rows[i].cells.length; j++) rowData.push(htmlTable.rows[i].cells[j].innerText);
        text += rowData.join("\t") + "\n";
    }
    navigator.clipboard.writeText(text).then(() => showToast("Tersalin. Paste ke Excel", "success"));
    writeAudit("EXPORT", "Rekap", "Export Excel");
}
function exportWordRekap() {
    const header = `<html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'><head><meta charset='utf-8'><title>Export</title><style>table{border-collapse:collapse;width:100%;}th,td{border:1px solid black;padding:5px;text-align:center;font-size:12px;}</style></head><body>`;
    const footer = "</body></html>";
    const content = document.getElementById("export-area").innerHTML;
    const blob = new Blob(['\ufeff', header + content + footer], { type: 'application/msword' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'Rekap_Wawancara_PEMIRA.doc'; a.click();
    writeAudit("EXPORT", "Rekap", "Export Word");
}
function exportPDFRekap() {
    document.getElementById('export-header').style.display = 'block';
    html2pdf().set({
        margin: [10, 5], filename: 'Rekap_Wawancara.pdf', image: { type: 'jpeg', quality: 0.98 },
        html2canvas: { scale: 2 }, jsPDF: { unit: 'mm', format: 'a4', orientation: 'landscape' }
    }).from(document.getElementById('export-area')).save().then(() => {
        document.getElementById('export-header').style.display = 'none';
        writeAudit("EXPORT", "Rekap", "Export PDF");
    });
}

// =====================================================================
// 10. MANAJEMEN INSTRUMEN DEV
// =====================================================================
function renderDevInstrumenTable() {
    const tbody = document.querySelector('#table-dev-inst tbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    const frm = document.getElementById('dev-inst-formasi').value;
    const dt = dbInstruments[frm] || {};

    Object.keys(dt).forEach(pos => {
        Object.keys(dt[pos]).forEach(asp => {
            const qs = dt[pos][asp];
            Object.keys(qs).sort((a, b) => (qs[a]?.order || 99) - (qs[b]?.order || 99)).forEach(qId => {
                if (qId === '_meta') return;
                const q = qs[qId];
                tbody.innerHTML += `<tr>
                    <td><span class="badge" style="background:#f1f5f9;color:#000">${pos}</span></td>
                    <td><b>${asp}</b></td>
                    <td style="font-size:12px;">${q.indikator}</td>
                    <td style="font-size:12px;">${q.pertanyaan}</td>
                    <td>1-${q.nilaiMax || 10}</td>
                    <td>${q.active !== false ? '<span style="color:green;font-weight:bold;">Aktif</span>' : '<span style="color:red;font-weight:bold;">Nonaktif</span>'}</td>
                    <td>
                        <button class="btn btn-outline btn-sm" onclick="toggleActiveInstrumen('${frm}','${pos}','${asp}','${qId}', ${q.active !== false})">On/Off</button>
                    </td>
                </tr>`;
            });
        });
    });
}

function toggleActiveInstrumen(frm, pos, asp, qId, currentStatus) {
    db.ref(`instruments/${frm}/${pos}/${asp}/${qId}`).update({ active: !currentStatus }).then(() => {
        writeAudit("UPDATE_QUESTION", "Instrumen", `Set active=${!currentStatus} pd ${qId}`);
    });
}

function triggerHapusSemuaInstrumen() {
    if (currentUser.role !== 'DEV') return;
    tampilkanModal("PERINGATAN KRITIS", `Menghapus seluruh bank instrumen. Data di-soft delete agar histori nilai aman.<br><br>Ketik:<br><b>HAPUS SEMUA INSTRUMEN</b>`, true, () => {
        if (document.getElementById('modal-input').value === "HAPUS SEMUA INSTRUMEN") {
            let updates = {};
            Object.keys(dbInstruments).forEach(frm => {
                Object.keys(dbInstruments[frm]).forEach(pos => {
                    Object.keys(dbInstruments[frm][pos]).forEach(asp => {
                        Object.keys(dbInstruments[frm][pos][asp]).forEach(qId => {
                            if (qId !== '_meta') updates[`instruments/${frm}/${pos}/${asp}/${qId}/active`] = false;
                        });
                    });
                });
            });
            db.ref().update(updates).then(() => {
                showToast("Semua instrumen dinonaktifkan.", "success");
                writeAudit("DELETE_ALL_INSTRUMENTS", "Instrumen", "Soft delete seluruh instrumen");
            });
        }
    });
}

// =====================================================================
// 11. MANAJEMEN RESET, HAPUS PESERTA ALL & AUDIT (DEV)
// =====================================================================
function triggerHapusSemuaPeserta() {
    if (currentUser.role !== 'DEV') return;
    tampilkanModal("PERINGATAN", `Hapus seluruh data peserta (Soft Delete).<br><br>Ketik:<br><b>HAPUS SEMUA PESERTA</b>`, true, () => {
        if (document.getElementById('modal-input').value === "HAPUS SEMUA PESERTA") {
            let updates = {};
            Object.keys(dbParticipants).forEach(pId => { updates[`participants/${pId}/active`] = false; });
            db.ref().update(updates).then(() => {
                showToast("Seluruh peserta dihapus (Soft Delete).", "success");
                writeAudit("DELETE_ALL_PARTICIPANTS", "Peserta", "Hapus semua peserta");
            });
        }
    });
}

function triggerResetAll() {
    if (currentUser.role !== 'DEV') return;
    tampilkanModal("RESET WAWANCARA", `Menghapus histori nilai/status. Peserta & Instrumen TETAP AMAN.<br><br>Ketik:<br><b>RESET WAWANCARA</b>`, true, () => {
        if (document.getElementById('modal-input').value === "RESET WAWANCARA") {
            backupProgress();
            db.ref('aspectSessions').remove();
            let updates = {};
            Object.keys(dbParticipants).forEach(pId => updates[`participants/${pId}/globalStatus`] = 'NOT_STARTED');
            db.ref().update(updates).then(() => {
                writeAudit("RESET_ALL", "Sistem", "Reset seluruh hasil wawancara");
                showToast("Sistem Berhasil Direset", "success");
            });
        }
    });
}

function backupProgress() {
    const bId = "BK_" + Date.now();
    let comp = 0; Object.values(dbSessions).forEach(s => { if (s.status === 'COMPLETED') comp++; });
    db.ref(`backups/${bId}`).set({
        timestamp: firebase.database.ServerValue.TIMESTAMP, createdBy: currentUser.name,
        summary: { pesertaTotal: Object.keys(dbParticipants).length, aspekSelesai: comp },
        data: { participants: dbParticipants, aspectSessions: dbSessions, instruments: dbInstruments }
    }).then(() => {
        showToast("Backup Berhasil", "success"); writeAudit("BACKUP", "Sistem", "Manual Backup"); loadBackups();
    });
}

function loadBackups() {
    db.ref('backups').once('value', snap => {
        const cont = document.getElementById('list-backups'); if (!cont) return; cont.innerHTML = '';
        if (!snap.exists()) return;
        let arr = []; snap.forEach(c => arr.push(c.val()));
        arr.reverse().forEach(v => {
            const d = new Date(v.timestamp).toLocaleString('id-ID');
            cont.innerHTML += `<div style="border-bottom:1px dashed #cbd5e1; padding:5px 0;"><b>${d}</b> oleh ${v.createdBy} <br> <span style="color:var(--text-muted)">Peserta: ${v.summary.pesertaTotal} | Aspek Selesai: ${v.summary.aspekSelesai}</span></div>`;
        });
    });
}

function filterAuditLog() {
    const tb = document.querySelector('#table-audit tbody'); if (!tb) return; tb.innerHTML = '';
    const q = document.getElementById('audit-search').value.toLowerCase();

    auditLogsArray.forEach(l => {
        if (q && !(l.action.toLowerCase().includes(q) || l.user.toLowerCase().includes(q) || l.target.toLowerCase().includes(q))) return;
        const d = new Date(l.timestamp).toLocaleString('id-ID');
        tb.innerHTML += `<tr>
            <td style="font-size:11px;">${d}</td><td><b>${l.user}</b></td>
            <td><span class="badge" style="background:#e2e8f0;color:#000">${l.role}</span></td>
            <td><span class="badge" style="background:#fef3c7;color:#92400e">${l.action}</span></td>
            <td>${l.module}</td><td style="font-size:12px;"><b>${l.target}</b><br><span style="color:var(--text-muted)">${l.keterangan}</span></td>
        </tr>`;
    });
}

function simpanSettings() {
    db.ref('settings').update({
        webName: document.getElementById('set-webname').value, status: document.getElementById('set-status')?.value || sysSettings.status || 'OPEN',
        durations: { POS_1: parseInt(document.getElementById('set-t1').value), POS_2: parseInt(document.getElementById('set-t2').value), POS_3: parseInt(document.getElementById('set-t3').value) }
    }).then(() => { showToast("Pengaturan disimpan", "success"); writeAudit("UPDATE_SETTINGS", "Sistem", "Ubah konfigurasi"); });
}

// =====================================================================
// SEEDER (hanya akun; instrumen demo DIHAPUS agar tidak bercampur data Excel)
// =====================================================================
function seedDemoData() {
    const defaults = [
        { name: "Super Admin", username: "dev", password: "dev", role: "DEV" },
        { name: "Pusat DKS", username: "dks", password: "dks", role: "DKS" },
        { name: "1 Perwakilan BPH", username: "pew_pos1", password: "123", role: "PEWAWANCARA", posId: "POS_1" },
        { name: "Ketua Komisi 1", username: "pew_pos3", password: "123", role: "PEWAWANCARA", posId: "POS_3" }
    ];
    db.ref('users').once('value').then(snap => {
        const ada = new Set();
        snap.forEach(c => ada.add(String((c.val() || {}).username || '').trim().toLowerCase()));
        // Buat hanya akun yang belum ada (tidak menimpa akun/password yang sudah ada)
        defaults.forEach(u => { if (!ada.has(u.username)) db.ref('users').push(u); });
    }).catch(err => console.error("Seed users gagal (cek Firebase Rules):", err));
}

// =====================================================================
// UTILITIES
// =====================================================================
function tampilkanModal(title, descHtml, reqInput, cb) {
    document.getElementById('modal-title').innerText = title;
    document.getElementById('modal-desc').innerHTML = descHtml;
    document.getElementById('modal-input-container').style.display = reqInput ? 'block' : 'none';
    const inp = document.getElementById('modal-input');
    inp.value = "";
    document.getElementById('modal-confirm-btn').onclick = () => { cb(); closeModal(); };
    document.getElementById('modal-overlay').style.display = 'flex';
}
function closeModal() { document.getElementById('modal-overlay').style.display = 'none'; }
function showToast(msg, type = "success") {
    const t = document.createElement('div'); t.className = `toast ${type}`; t.innerText = msg;
    document.getElementById('toast-container').appendChild(t);
    setTimeout(() => t.remove(), 3500);
}
function writeAudit(action, module, keterangan, target = "-", oldVal = "-", newVal = "-") {
    db.ref('auditLogs').push({
        timestamp: firebase.database.ServerValue.TIMESTAMP,
        user: currentUser.name, role: currentUser.role,
        action, module, target, keterangan, oldVal: oldVal || "-", newVal
    });
}