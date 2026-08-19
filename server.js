const express = require("express");
const cors = require("cors");
const QRCode = require("qrcode");
const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
require("dotenv").config();


const app = express();

app.use((req, res, next) => {
    if (req.path === "/admin" || req.path.startsWith("/admin/")) {
        const h = req.headers.authorization || "";

        if (!h.startsWith("Basic ")) {
            res.set("WWW-Authenticate", 'Basic realm="MyGateway Admin"');
            return res.status(401).send("Admin login required");
        }

        const decoded = Buffer.from(h.substring(6), "base64").toString();
        const i = decoded.indexOf(":");
        const user = i >= 0 ? decoded.substring(0, i) : "";
        const pass = i >= 0 ? decoded.substring(i + 1) : "";

        if (
            user !== (process.env.ADMIN_USER || "admin") ||
            pass !== (process.env.ADMIN_PASS || "ChangeMe@12345")
        ) {
            res.set("WWW-Authenticate", 'Basic realm="MyGateway Admin"');
            return res.status(401).send("Invalid username or password");
        }
    }

    next();
});

const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
    if (req.path === "/admin" || req.path.startsWith("/admin/")) {
        return next();
    }
    express.static("public")(req, res, next);
});

const DB_FILE = path.join(__dirname, "database.json");

const defaultDB = {
    settings: {
        gateway_name: "MyGateway",
        merchant_name: "",
        upi_id: "",
        logo_url: "",
        support: ""
    },
    orders: []
};

function loadDB() {
    if (!fs.existsSync(DB_FILE)) {
        fs.writeFileSync(DB_FILE, JSON.stringify(defaultDB, null, 2));
    }

    return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
}

function saveDB(db) {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}


function adminAuth(req, res, next) {
    const user = process.env.ADMIN_USER;
    const pass = process.env.ADMIN_PASS;

    const header = req.headers.authorization || "";

    if (!header.startsWith("Basic ")) {
        res.set("WWW-Authenticate", 'Basic realm="MyGateway Admin"');
        return res.status(401).send("Admin login required");
    }

    const decoded = Buffer.from(header.slice(6), "base64").toString();
    const [username, password] = decoded.split(":");

    if (username !== user || password !== pass) {
        res.set("WWW-Authenticate", 'Basic realm="MyGateway Admin"');
        return res.status(401).send("Invalid username or password");
    }

    next();
}

app.get("/api/status", (req, res) => {
    res.json({
        success: true,
        gateway: "MyGateway",
        status: "online"
    });
});

app.get("/api/settings", (req, res) => {
    const db = loadDB();

    res.json({
        success: true,
        settings: db.settings
    });
});

app.post("/api/settings", adminAuth, (req, res) => {
    const db = loadDB();

    db.settings = {
        gateway_name: req.body.gateway_name || "MyGateway",
        merchant_name: req.body.merchant_name || "",
        upi_id: req.body.upi_id || "",
        logo_url: req.body.logo_url || "",
        support: req.body.support || ""
    };

    saveDB(db);

    res.json({
        success: true,
        message: "Gateway settings saved"
    });
});

app.post("/api/payment/create", (req, res) => {
    const db = loadDB();
    const amount = Number(req.body.amount);

    if (!Number.isFinite(amount) || amount <= 0) {
        return res.status(400).json({
            success: false,
            message: "Invalid amount"
        });
    }

    const orderId =
        req.body.orderId ||
        `MG_${Date.now()}_${uuidv4().slice(0, 8)}`;

    const existing = db.orders.find(
        order => order.order_id === orderId
    );

    if (existing) {
        return res.json({
            success: true,
            orderId: existing.order_id,
            amount: existing.amount,
            paymentUrl: `/pay/${existing.order_id}`
        });
    }

    const order = {
        order_id: orderId,
        amount: Number(amount.toFixed(2)),
        user_id: req.body.userId || "",
        product: req.body.product || "",
        utr: "",
        status: "PENDING",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
    };

    db.orders.push(order);
    saveDB(db);

    res.json({
        success: true,
        orderId: order.order_id,
        amount: order.amount,
        paymentUrl: `/pay/${order.order_id}`
    });
});

app.get("/api/order/:orderId", (req, res) => {
    const db = loadDB();

    const order = db.orders.find(
        item => item.order_id === req.params.orderId
    );

    if (!order) {
        return res.status(404).json({
            success: false,
            message: "Order not found"
        });
    }

    res.json({
        success: true,
        order
    });
});

app.post("/api/order/:orderId/utr", (req, res) => {
    const db = loadDB();
    const utr = String(req.body.utr || "").trim();

    if (utr.length < 6) {
        return res.status(400).json({
            success: false,
            message: "Please enter a valid UTR"
        });
    }

    const order = db.orders.find(
        item => item.order_id === req.params.orderId
    );

    if (!order) {
        return res.status(404).json({
            success: false,
            message: "Order not found"
        });
    }

    if (order.utr) {
        return res.status(400).json({
            success: false,
            message: "UTR already submitted for this order"
        });
    }

    const duplicateUTR = db.orders.find(
        item => item.order_id !== order.order_id &&
                String(item.utr || "").trim().toLowerCase() === utr.toLowerCase()
    );

    if (duplicateUTR) {
        return res.status(400).json({
            success: false,
            message: "This UTR has already been used"
        });
    }

    order.utr = utr;
    order.status = "PROCESSING";
    order.updated_at = new Date().toISOString();

    saveDB(db);

    res.json({
        success: true,
        message: "UTR submitted successfully",
        status: "PROCESSING"
    });
});

app.get("/api/admin/orders", adminAuth, (req, res) => {
    const db = loadDB();

    res.json({
        success: true,
        orders: db.orders
    });
});

app.post("/api/admin/order/:orderId/status", adminAuth, (req, res) => {
    const db = loadDB();

    const allowed = [
        "PENDING",
        "PROCESSING",
        "APPROVED",
        "REJECTED"
    ];

    if (!allowed.includes(req.body.status)) {
        return res.status(400).json({
            success: false,
            message: "Invalid status"
        });
    }

    const order = db.orders.find(
        item => item.order_id === req.params.orderId
    );

    if (!order) {
        return res.status(404).json({
            success: false,
            message: "Order not found"
        });
    }

    order.status = req.body.status;
    order.updated_at = new Date().toISOString();

    saveDB(db);

    res.json({
        success: true,
        status: order.status
    });
});

app.get("/api/payment/qr/:orderId", async (req, res) => {
    const db = loadDB();

    const order = db.orders.find(
        item => item.order_id === req.params.orderId
    );

    if (!order) {
        return res.status(404).json({
            success: false,
            message: "Order not found"
        });
    }

    if (!db.settings.upi_id) {
        return res.status(400).json({
            success: false,
            message: "UPI ID is not configured"
        });
    }

    const upiUrl =
        `upi://pay?pa=${encodeURIComponent(db.settings.upi_id)}` +
        `&pn=${encodeURIComponent(db.settings.merchant_name || db.settings.gateway_name)}` +
        `&am=${order.amount.toFixed(2)}` +
        `&cu=INR` +
        `&tn=${encodeURIComponent(order.order_id)}`;

    try {
        const qr = await QRCode.toDataURL(upiUrl);

        res.json({
            success: true,
            orderId: order.order_id,
            amount: order.amount,
            upiUrl,
            qr
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: "QR generation failed"
        });
    }
});

app.get("/pay/:orderId", (req, res) => {
    res.sendFile(
        path.join(__dirname, "public", "pay", "index.html")
    );
});

app.get("/admin", adminAuth, (req, res) => {
    res.sendFile(
        path.join(__dirname, "public", "admin", "index.html")
    );
});


app.get("/admin/", adminAuth, (req, res) => {
    res.sendFile(
        path.join(__dirname, "public", "admin", "index.html")
    );
});

app.listen(PORT, "0.0.0.0", () => {
    console.log("==================================");
    console.log(" MyGateway Backend Started");
    console.log(` Port: ${PORT}`);
    console.log("==================================");
});
