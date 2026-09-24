// backend/server.js
const express = require('express');
const mongoose = require('mongoose');
const axios = require('axios');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const app = express();

// --- KONFIGURACJA VERCEL ---
const IS_VERCEL = !!process.env.VERCEL;
if (IS_VERCEL) {
    app.set('trust proxy', 1);
}

// --- MIDDLEWARE ---
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Statyczne pliki (lokalnie — na Vercel frontend serwuje osobny service)
if (!IS_VERCEL) {
    app.use(express.static(path.join(__dirname, '../frontend')));
}

// --- SESJA (z MongoDB store — działa na Vercel) ---
// Sprawdź czy MONGODB_URI jest dostępne
if (!process.env.MONGODB_URI) {
    console.error('❌ BRAK MONGODB_URI w zmiennych środowiskowych!');
}

// Sesja z bezpiecznym store'em
const sessionConfig = {
    secret: process.env.SESSION_SECRET || 'fallback-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: IS_VERCEL,
        httpOnly: true,
        sameSite: IS_VERCEL ? 'none' : 'lax',
        maxAge: 24 * 60 * 60 * 1000
    }
};

// Użyj MongoStore tylko jeśli MONGODB_URI istnieje
if (process.env.MONGODB_URI) {
    try {
        sessionConfig.store = MongoStore.create({
            mongoUrl: process.env.MONGODB_URI,
            collectionName: 'sessions',
            ttl: 24 * 60 * 60,
            autoRemove: 'native'
        });
        console.log('✅ Sesje: MongoDB store skonfigurowany');
    } catch (err) {
        console.error('❌ Błąd konfiguracji MongoStore:', err.message);
        console.warn('⚠️ Fallback do MemoryStore (sesje będą ulotne)');
    }
} else {
    console.warn('⚠️ Brak MONGODB_URI – używam MemoryStore');
}

app.use(session(sessionConfig));

// --- POŁĄCZENIE Z BAZĄ ---
mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log('✅ Połączono z MongoDB'))
    .catch(err => console.error('❌ Błąd połączenia z MongoDB:', err.message));

// --- MODELE ---
const User = mongoose.model('User', new mongoose.Schema({
    kickId: { type: String, unique: true },
    username: String,
    profilePicture: String,
    points: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now }
}));

const Admin = mongoose.model('Admin', new mongoose.Schema({
    username: { type: String, unique: true },
    passwordHash: String,
    createdAt: { type: Date, default: Date.now }
}));

const Giveaway = mongoose.model('Giveaway', new mongoose.Schema({
    title: String,
    description: String,
    image: String,
    cost: Number,
    endDate: Date,
    status: { type: String, enum: ['active', 'finished'], default: 'active' },
    winnerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    winnerUsername: String,
    createdAt: { type: Date, default: Date.now }
}, { timestamps: true }));

const GiveawayEntry = mongoose.model('GiveawayEntry', new mongoose.Schema({
    giveawayId: { type: mongoose.Schema.Types.ObjectId, ref: 'Giveaway' },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    username: String,
    createdAt: { type: Date, default: Date.now }
}));

const LeaderboardCache = mongoose.model('LeaderboardCache', new mongoose.Schema({
    data: Array,
    updatedAt: { type: Date, default: Date.now }
}));

// --- BOTRIX CACHE ---
let botrixCache = {
    data: null,
    timestamp: 0
};
const BOTRIX_CACHE_TTL = 2 * 60 * 1000; // 2 minuty

// --- FUNKCJA: Uruchomienie przeglądarki (Vercel vs lokalnie) ---
async function launchBrowser() {
    if (IS_VERCEL) {
        const chromium = require('@sparticuz/chromium');
        const puppeteerCore = require('puppeteer-core');
        return puppeteerCore.launch({
            args: chromium.args,
            defaultViewport: chromium.defaultViewport,
            executablePath: await chromium.executablePath(),
            headless: chromium.headless,
        });
    } else {
        const puppeteer = require('puppeteer');
        return puppeteer.launch({
            headless: 'new',
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
    }
}

// --- FUNKCJA: Pobranie leaderboardu z Botrixa (z cache + paginacja) ---
async function getBotrixLeaderboard() {
    const now = Date.now();

    if (botrixCache.data && now - botrixCache.timestamp < BOTRIX_CACHE_TTL) {
        return botrixCache.data;
    }

    const channelName = process.env.BOTRIX_CHANNEL_NAME;
    if (!channelName) {
        console.warn('⚠️ Brak BOTRIX_CHANNEL_NAME w .env');
        return botrixCache.data || [];
    }

    const MAX_ENTRIES = 50;
    const MAX_PAGES = 10;

    let browser;
    try {
        browser = await launchBrowser();
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        const allEntries = [];
        const seenUsernames = new Set();

        for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
            if (allEntries.length >= MAX_ENTRIES) break;

            const url = `https://botrix.live/k/${channelName}/leaderboard?page=${pageNum}`;
            console.log(`🔄 Pobieranie strony ${pageNum}...`);

            try {
                await page.goto(url, {
                    waitUntil: 'networkidle2',
                    timeout: 30000
                });
                await page.waitForSelector('table tbody tr', { timeout: 10000 });
            } catch (e) {
                console.log(`⏹️ Brak tabeli na stronie ${pageNum} – koniec paginacji`);
                break;
            }

            await new Promise(r => setTimeout(r, 800));

            const entries = await page.evaluate(() => {
                const rows = Array.from(document.querySelectorAll('table tbody tr'));
                return rows.map(row => {
                    const cells = row.querySelectorAll('td');
                    if (cells.length < 6) return null;
                    const position = parseInt(cells[0].innerText.trim().replace('#', ''), 10);
                    const username = cells[1].innerText.trim();
                    const messages = cells[2].innerText.trim();
                    const level = cells[3].innerText.trim();
                    const points = parseInt(cells[4].innerText.trim().replace(/,/g, ''), 10) || 0;
                    const watchtime = cells[5].innerText.trim();
                    return { position, username, messages, level, points, watchtime };
                }).filter(Boolean);
            });

            if (entries.length === 0) {
                console.log(`⏹️ Strona ${pageNum} pusta – koniec paginacji`);
                break;
            }

            let added = 0;
            for (const entry of entries) {
                const key = entry.username.toLowerCase();
                if (!seenUsernames.has(key)) {
                    seenUsernames.add(key);
                    allEntries.push(entry);
                    added++;
                }
            }

            console.log(`   ✅ Dodano ${added} nowych (łącznie: ${allEntries.length})`);

            if (entries.length < 10) {
                console.log(`⏹️ Ostatnia strona (mniej niż 10 wyników)`);
                break;
            }
        }

        const finalEntries = allEntries
            .sort((a, b) => a.position - b.position)
            .slice(0, MAX_ENTRIES);

        botrixCache = { data: finalEntries, timestamp: now };
        console.log(`📊 Odświeżono cache Botrix (${finalEntries.length} pozycji)`);
        return finalEntries;

    } catch (error) {
        console.error('❌ Błąd scrapowania Botrix:', error.message);
        return botrixCache.data || [];
    } finally {
        if (browser) await browser.close();
    }
}

// --- FUNKCJA: Znajdź punkty użytkownika w Botrixie ---
async function getBotrixPointsForUser(kickUsername) {
    const leaderboard = await getBotrixLeaderboard();
    if (!leaderboard.length) return null;

    const normalized = kickUsername.trim().toLowerCase();
    const entry = leaderboard.find(u => u.username.trim().toLowerCase() === normalized);

    if (entry) {
        console.log(`🎯 Dopasowano w Botrix: ${entry.username} → ${entry.points} PKT`);
        return entry.points;
    }

    console.log(`⚠️ Nie znaleziono użytkownika "${kickUsername}" w leaderboardzie Botrix`);
    return null;
}

// --- TWORZENIE ADMINA PRZY STARCIE ---
async function ensureAdminExists() {
    try {
        const adminUsername = process.env.ADMIN_USERNAME || 'admin';
        const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';

        const existing = await Admin.findOne({ username: adminUsername });
        if (!existing) {
            const hash = await bcrypt.hash(adminPassword, 12);
            await new Admin({ username: adminUsername, passwordHash: hash }).save();
            console.log(`🔐 Utworzono konto admina: ${adminUsername}`);
            console.log(`⚠️  Zmień hasło w pliku .env!`);
        }
    } catch (err) {
        console.error('❌ Błąd ensureAdminExists:', err.message);
    }
}
mongoose.connection.once('open', ensureAdminExists);

// --- RATE LIMIT DLA LOGOWANIA ADMINA ---
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: { error: 'Zbyt wiele prób logowania. Spróbuj ponownie za 15 minut.' }
});

// --- MIDDLEWARE: Sprawdzenie admina ---
function requireAdmin(req, res, next) {
    if (!req.session.isAdmin) {
        return res.status(401).json({ error: 'Brak autoryzacji' });
    }
    next();
}

// ==================== LOGOWANIE KICK ====================

app.get('/auth/kick', (req, res) => {
    try {
        const codeVerifier = crypto.randomBytes(32).toString('hex');
        const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
        req.session.codeVerifier = codeVerifier;

        const state = crypto.randomBytes(16).toString('hex');
        req.session.oauthState = state;

        const params = new URLSearchParams({
            response_type: 'code',
            client_id: process.env.KICK_CLIENT_ID,
            redirect_uri: process.env.KICK_REDIRECT_URI,
            scope: 'user:read',
            state: state,
            code_challenge: codeChallenge,
            code_challenge_method: 'S256'
        });

        res.redirect(`https://id.kick.com/oauth/authorize?${params.toString()}`);
    } catch (error) {
        console.error('❌ Błąd generowania URL:', error.message);
        res.status(500).send('Błąd serwera podczas logowania.');
    }
});

app.get('/auth/kick/callback', async (req, res) => {
    const { code, state } = req.query;

    if (!state || state !== req.session.oauthState) {
        return res.status(403).send('Nieautoryzowane.');
    }
    if (!code || !req.session.codeVerifier) {
        return res.status(400).send('Brak kodu lub sesja wygasła.');
    }

    try {
        const tokenRequestBody = new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: process.env.KICK_CLIENT_ID,
            client_secret: process.env.KICK_CLIENT_SECRET,
            code: code,
            redirect_uri: process.env.KICK_REDIRECT_URI,
            code_verifier: req.session.codeVerifier
        });

        const tokenResponse = await axios.post('https://id.kick.com/oauth/token',
            tokenRequestBody.toString(),
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 }
        );

        const accessToken = tokenResponse.data.access_token;

        const userResponse = await axios.get('https://api.kick.com/public/v1/users', {
            headers: { 'Authorization': `Bearer ${accessToken}`, 'Accept': 'application/json' },
            timeout: 10000
        });

        const rawUser = userResponse.data.data[0];

        let user = await User.findOne({ kickId: rawUser.user_id });
        if (!user) {
            user = new User({
                kickId: rawUser.user_id,
                username: rawUser.name,
                profilePicture: rawUser.profile_picture,
                points: 0
            });
            await user.save();
            console.log(`🆕 Utworzono nowego użytkownika: ${user.username}`);
        } else {
            console.log(`👋 Powracający użytkownik: ${user.username}`);
        }

        try {
            const botrixPoints = await getBotrixPointsForUser(rawUser.name);
            if (botrixPoints !== null && botrixPoints !== user.points) {
                user.points = botrixPoints;
                await user.save();
                console.log(`💾 Zaktualizowano punkty ${user.username} → ${botrixPoints} PKT`);
            } else if (botrixPoints !== null) {
                console.log(`✅ Punkty już aktualne (${botrixPoints} PKT)`);
            }
        } catch (err) {
            console.error('⚠️ Błąd synchronizacji z Botrixem:', err.message);
        }

        req.session.userId = user._id;
        req.session.username = user.username;
        delete req.session.codeVerifier;
        delete req.session.oauthState;

        res.redirect('/');
    } catch (error) {
        console.error('❌ Błąd autoryzacji Kick:', error.response?.data || error.message);
        res.status(500).send('Wystąpił błąd podczas logowania.');
    }
});

app.get('/api/me', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Nie jesteś zalogowany' });
    try {
        const user = await User.findById(req.session.userId);
        if (!user) return res.status(404).json({ error: 'Nie znaleziono użytkownika' });
        res.json({
            username: user.username || 'Użytkownik',
            points: user.points || 0,
            avatar: user.profilePicture || ''
        });
    } catch (error) {
        res.status(500).json({ error: 'Błąd serwera' });
    }
});

app.get('/api/logout', (req, res) => {
    req.session.destroy(() => res.json({ success: true }));
});

// ==================== PUBLICZNE API LOSOWAŃ ====================

app.get('/api/giveaways', async (req, res) => {
    try {
        const active = await Giveaway.find({ status: 'active' }).sort({ endDate: 1 });
        const activeResult = await Promise.all(active.map(async (g) => {
            const entryCount = await GiveawayEntry.countDocuments({ giveawayId: g._id });
            return { ...g.toObject(), entryCount };
        }));

        const finished = await Giveaway.find({
            status: 'finished',
            winnerUsername: { $ne: null }
        }).sort({ updatedAt: -1 }).limit(6);

        const finishedResult = await Promise.all(finished.map(async (g) => {
            const entryCount = await GiveawayEntry.countDocuments({ giveawayId: g._id });
            return { ...g.toObject(), entryCount };
        }));

        res.json([...activeResult, ...finishedResult]);
    } catch (error) {
        console.error('Błąd /api/giveaways:', error.message);
        res.status(500).json({ error: 'Błąd serwera' });
    }
});

app.post('/api/giveaways/:id/join', async (req, res) => {
    if (!req.session.userId) {
        return res.status(401).json({ error: 'Musisz być zalogowany' });
    }

    try {
        const giveaway = await Giveaway.findById(req.params.id);
        if (!giveaway || giveaway.status !== 'active') {
            return res.status(404).json({ error: 'Losowanie nie istnieje lub zakończone' });
        }

        if (new Date() > new Date(giveaway.endDate)) {
            return res.status(400).json({ error: 'Losowanie już się zakończyło' });
        }

        const user = await User.findById(req.session.userId);
        if (!user) return res.status(404).json({ error: 'Nie znaleziono użytkownika' });

        if (user.points < giveaway.cost) {
            return res.status(400).json({ error: 'Za mało punktów' });
        }

        user.points -= giveaway.cost;
        await user.save();

        await new GiveawayEntry({
            giveawayId: giveaway._id,
            userId: user._id,
            username: user.username
        }).save();

        res.json({ success: true, newBalance: user.points });
    } catch (error) {
        console.error('Błąd join:', error.message);
        res.status(500).json({ error: 'Błąd serwera' });
    }
});

// ==================== ADMIN: LOGOWANIE ====================

app.post('/api/admin/login', loginLimiter, async (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ error: 'Podaj login i hasło' });
    }

    try {
        const admin = await Admin.findOne({ username });
        if (!admin) {
            return res.status(401).json({ error: 'Nieprawidłowe dane logowania' });
        }

        const ok = await bcrypt.compare(password, admin.passwordHash);
        if (!ok) {
            return res.status(401).json({ error: 'Nieprawidłowe dane logowania' });
        }

        req.session.isAdmin = true;
        req.session.adminUsername = admin.username;
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Błąd serwera' });
    }
});

app.post('/api/admin/logout', (req, res) => {
    req.session.isAdmin = false;
    res.json({ success: true });
});

app.get('/api/admin/me', (req, res) => {
    if (!req.session.isAdmin) return res.status(401).json({ error: 'Brak autoryzacji' });
    res.json({ username: req.session.adminUsername });
});

// ==================== ADMIN: STATYSTYKI ====================

app.get('/api/admin/stats', requireAdmin, async (req, res) => {
    try {
        const totalUsers = await User.countDocuments();
        const totalPointsAgg = await User.aggregate([{ $group: { _id: null, total: { $sum: '$points' } } }]);
        const totalPoints = totalPointsAgg[0]?.total || 0;
        const activeGiveaways = await Giveaway.countDocuments({ status: 'active' });
        const finishedGiveaways = await Giveaway.countDocuments({ status: 'finished' });
        const totalEntries = await GiveawayEntry.countDocuments();

        const recentUsers = await User.find().sort({ createdAt: -1 }).limit(5).select('username points createdAt');
        const topUsers = await User.find().sort({ points: -1 }).limit(10).select('username points');

        res.json({
            totalUsers, totalPoints, activeGiveaways, finishedGiveaways, totalEntries,
            recentUsers, topUsers
        });
    } catch (error) {
        res.status(500).json({ error: 'Błąd serwera' });
    }
});

// ==================== ADMIN: ZARZĄDZANIE UŻYTKOWNIKAMI ====================

app.get('/api/admin/users', requireAdmin, async (req, res) => {
    try {
        const users = await User.find().sort({ points: -1 });
        res.json(users);
    } catch (error) {
        res.status(500).json({ error: 'Błąd serwera' });
    }
});

app.post('/api/admin/users/:id/points', requireAdmin, async (req, res) => {
    const { amount, action } = req.body;
    try {
        const user = await User.findById(req.params.id);
        if (!user) return res.status(404).json({ error: 'Nie znaleziono użytkownika' });

        if (action === 'set') {
            user.points = Number(amount);
        } else {
            user.points += Number(amount);
        }
        await user.save();
        res.json({ success: true, newBalance: user.points });
    } catch (error) {
        res.status(500).json({ error: 'Błąd serwera' });
    }
});

app.delete('/api/admin/users/:id', requireAdmin, async (req, res) => {
    try {
        await User.findByIdAndDelete(req.params.id);
        await GiveawayEntry.deleteMany({ userId: req.params.id });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Błąd serwera' });
    }
});

// ==================== ADMIN: ZARZĄDZANIE LOSOWANIAMI ====================

app.get('/api/admin/giveaways', requireAdmin, async (req, res) => {
    try {
        const giveaways = await Giveaway.find().sort({ createdAt: -1 });
        const result = await Promise.all(giveaways.map(async (g) => {
            const entries = await GiveawayEntry.find({ giveawayId: g._id }).select('username createdAt');
            return { ...g.toObject(), entries };
        }));
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: 'Błąd serwera' });
    }
});

app.post('/api/admin/giveaways', requireAdmin, async (req, res) => {
    const { title, description, image, cost, endDate } = req.body;

    if (!title || !cost || !endDate) {
        return res.status(400).json({ error: 'Wypełnij wymagane pola' });
    }

    try {
        const giveaway = new Giveaway({
            title,
            description: description || '',
            image: image || '',
            cost: Number(cost),
            endDate: new Date(endDate)
        });
        await giveaway.save();
        res.json({ success: true, giveaway });
    } catch (error) {
        res.status(500).json({ error: 'Błąd serwera' });
    }
});

app.delete('/api/admin/giveaways/:id', requireAdmin, async (req, res) => {
    try {
        await Giveaway.findByIdAndDelete(req.params.id);
        await GiveawayEntry.deleteMany({ giveawayId: req.params.id });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Błąd serwera' });
    }
});

app.post('/api/admin/giveaways/:id/draw', requireAdmin, async (req, res) => {
    try {
        const giveaway = await Giveaway.findById(req.params.id);
        if (!giveaway) return res.status(404).json({ error: 'Nie znaleziono losowania' });
        if (giveaway.status === 'finished') {
            return res.status(400).json({ error: 'Losowanie już zakończone' });
        }

        const entries = await GiveawayEntry.find({ giveawayId: giveaway._id });
        if (entries.length === 0) {
            return res.status(400).json({ error: 'Brak uczestników' });
        }

        const winnerIndex = crypto.randomInt(0, entries.length);
        const winner = entries[winnerIndex];

        giveaway.status = 'finished';
        giveaway.winnerId = winner.userId;
        giveaway.winnerUsername = winner.username;
        await giveaway.save();

        res.json({
            success: true,
            winner: winner.username,
            totalEntries: entries.length
        });
    } catch (error) {
        res.status(500).json({ error: 'Błąd serwera' });
    }
});

// ==================== BOTRIX: LEADERBOARD ====================

// Zwraca ranking z cache (bez scrapowania) - szybko!
app.get('/api/botrix-leaderboard', async (req, res) => {
    try {
        const cached = await LeaderboardCache.findOne().sort({ updatedAt: -1 });
        if (cached && cached.data && cached.data.length > 0) {
            return res.json(cached.data);
        }
        res.json([]);
    } catch (error) {
        console.error('❌ Błąd /api/botrix-leaderboard:', error.message);
        res.status(500).json({ error: 'Błąd serwera' });
    }
});

// ==================== BOTRIX: RĘCZNA SYNCHRONIZACJA ====================

// ==================== BOTRIX: RĘCZNA SYNCHRONIZACJA ====================

app.get('/api/sync-botrix', async (req, res) => {
    try {
        botrixCache.timestamp = 0;
        const leaderboard = await getBotrixLeaderboard();

        if (!leaderboard || leaderboard.length === 0) {
            return res.status(500).json({ error: 'Nie udało się pobrać rankingu' });
        }

        // Zapisz do bazy (zastąp stary wpis)
        await LeaderboardCache.deleteMany({});
        await new LeaderboardCache({ data: leaderboard, updatedAt: new Date() }).save();

        // Zaktualizuj punkty użytkowników w bazie
        let updated = 0;
        for (const entry of leaderboard) {
            const user = await User.findOne({
                username: { $regex: new RegExp(`^${entry.username}$`, 'i') }
            });
            if (user && user.points !== entry.points) {
                user.points = entry.points;
                await user.save();
                updated++;
            }
        }

        res.json({
            success: true,
            saved: leaderboard.length,
            updated,
            message: `Zapisano ${leaderboard.length} pozycji, zaktualizowano ${updated} użytkowników.`
        });
    } catch (error) {
        console.error('❌ Błąd sync:', error);
        res.status(500).json({ error: error.message });
    }
});

// ==================== URUCHOMIENIE ====================
// Lokalnie: app.listen. Na Vercel: export app.

if (!IS_VERCEL) {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log(`🚀 Serwer działa na porcie ${PORT}`);
        console.log(`🔗 http://localhost:${PORT}`);
    });
}

app.get('/api/diag', (req, res) => {
    res.json({
        nodeVersion: process.version,
        isVercel: !!process.env.VERCEL,
        env: {
            hasMongoUri: !!process.env.MONGODB_URI,
            mongoUriLength: (process.env.MONGODB_URI || '').length,
            mongoUriStart: (process.env.MONGODB_URI || '').substring(0, 20) + '...',
            hasSessionSecret: !!process.env.SESSION_SECRET,
            hasKickClientId: !!process.env.KICK_CLIENT_ID,
            hasKickClientSecret: !!process.env.KICK_CLIENT_SECRET,
            hasKickRedirectUri: !!process.env.KICK_REDIRECT_URI,
            hasBotrixChannel: !!process.env.BOTRIX_CHANNEL_NAME,
            hasAdminUsername: !!process.env.ADMIN_USERNAME,
            hasAdminPassword: !!process.env.ADMIN_PASSWORD,
            kickRedirectUri: process.env.KICK_REDIRECT_URI
        },
        mongoState: mongoose.connection.readyState
    });
});

module.exports = app;