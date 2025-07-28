// === FILE: index.js ===
const StellarSdk = require('stellar-sdk');
const ed25519 = require('ed25519-hd-key');
const bip39 = require('bip39');
const axios = require('axios');
const fs = require('fs');
require("dotenv").config();
const { URLSearchParams } = require('url');

const PI_API_SERVER = 'https://api.mainnet.minepi.com';
const PI_NETWORK_PASSPHRASE = 'Pi Network';
const DELAY_BETWEEN_WALLETS_MS = 1; // jeda 1 detik saja agar gak time mojrot wkw
const server = new StellarSdk.Server(PI_API_SERVER);

async function sendTelegramNotification(message) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) return;
    try {
        await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
            chat_id: chatId,
            text: message,
            parse_mode: 'HTML',
            disable_web_page_preview: true
        });
    } catch (e) {
        console.error("Telegram error:", e.message);
    }
}

function loadMnemonics() {
    try {
        const data = fs.readFileSync('mnemonics.txt', 'utf8');
        const lines = data.split(/\r?\n/).filter(l => l.trim() !== '');
        if (!lines.length) throw new Error("File mnemonics.txt kosong!");
        return lines;
    } catch (e) {
        console.error("❌ Gagal baca file mnemonics.txt:", e.message);
        process.exit(1);
    }
}

async function getWalletFromMnemonic(mnemonic) {
    if (!bip39.validateMnemonic(mnemonic)) throw new Error("Mnemonic tidak valid.");
    const seed = await bip39.mnemonicToSeed(mnemonic);
    const { key } = ed25519.derivePath("m/44'/314159'/0'", seed.toString('hex'));
    const keypair = StellarSdk.Keypair.fromRawEd25519Seed(key);
    return { publicKey: keypair.publicKey(), secretKey: keypair.secret() };
}

async function submitTransaction(xdr) {
    try {
        const response = await axios.post(`${PI_API_SERVER}/transactions`, new URLSearchParams({ tx: xdr }), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            timeout: 30000
        });
        if (response.data.status === 'ERROR') throw new Error(response.data.detail);
        return response.data;
    } catch (e) {
        throw new Error("Gagal submit transaksi: " + (e.response?.data?.detail || e.message));
    }
}

async function sendPi(mnemonic, recipient, walletIndex) {
    let wallet;
    try {
        wallet = await getWalletFromMnemonic(mnemonic);
        const sender = wallet.publicKey;
        console.log(`\n🔑 Wallet #${walletIndex + 1}: ${sender}`);

        const account = await server.loadAccount(sender);
        const nativeBalance = account.balances.find(b => b.asset_type === 'native');
        if (!nativeBalance) throw new Error("Wallet tidak memiliki saldo Pi.");

        const balance = parseFloat(nativeBalance.balance);
        const fee = await server.fetchBaseFee() / 1e7;
        const amount = balance - 1 - fee;
        if (amount <= 0) throw new Error("Saldo tidak cukup untuk transfer (butuh > 1 Pi).");

        const formattedAmount = amount.toFixed(7);
        const memo = process.env.MEMO_TEXT || '';

        const tx = new StellarSdk.TransactionBuilder(account, {
            fee: (fee * 1e7).toString(),
            networkPassphrase: PI_NETWORK_PASSPHRASE
        })
            .addOperation(StellarSdk.Operation.payment({
                destination: recipient,
                asset: StellarSdk.Asset.native(),
                amount: formattedAmount
            }))
            .addMemo(StellarSdk.Memo.text(memo))
            .setTimeout(30)
            .build();

        tx.sign(StellarSdk.Keypair.fromSecret(wallet.secretKey));
        const res = await submitTransaction(tx.toXDR());

        const notif = `✅ <b>Transaksi Berhasil!</b>\n\n` +
            `🆔 <b>TX Hash:</b> <code>${res.hash}</code>\n` +
            `👤 <b>Dari:</b> <code>${sender}</code>\n` +
            `👤 <b>Ke:</b> <code>${recipient}</code>\n` +
            `💰 <b>Jumlah:</b> <code>${formattedAmount} π</code>\n` +
            `📅 <b>Waktu:</b> ${new Date().toISOString()}\n` +
            `🔗 <a href="https://blockexplorer.minepi.com/mainnet/transactions/${res.hash}">Detail Transaksi</a>`;

        console.log(notif);
        await sendTelegramNotification(notif);

    } catch (e) {
        const addr = wallet?.publicKey || `Wallet #${walletIndex + 1}`;
        console.error(`❌ Gagal Transfer ${addr}:`, e.message);
        if (!e.message.includes("Saldo tidak cukup")) {
            await sendTelegramNotification(`❌ <b>Gagal Transfer</b> dari <code>${addr}</code>
Alasan: ${e.message}`);
        }
    }
}

(async () => {
    console.log("Memulai bot transfer Pi...");
    const mnemonics = loadMnemonics();
    const recipient = process.env.RECEIVER_ADDRESS;
    if (!recipient?.startsWith('G')) {
        console.error("❌ RECEIVER_ADDRESS tidak valid!");
        process.exit(1);
    }
    let index = 0;
    while (true) {
        await sendPi(mnemonics[index], recipient, index);
        index = (index + 1) % mnemonics.length;
        if (index === 0) {
            console.log(`\n🔁 Siklus ulang semua wallet selesai. Menunggu...`);
        }
        await new Promise(r => setTimeout(r, DELAY_BETWEEN_WALLETS_MS));
    }
})();
