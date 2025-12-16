const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { createClient } = require('@supabase/supabase-js');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid'); 

dotenv.config();
const app = express();
const PORT = process.env.PORT || 3000;
// *** การแก้ไขที่ 2: กำหนด BACKEND_URL ***
// ใช้สำหรับการสร้างลิงก์ที่ชี้กลับมาที่เซิร์ฟเวอร์นี้ (ถ้าจำเป็น)
const BACKEND_URL = process.env.BACKEND_URL || `http://localhost:${PORT}`; 


// Middleware
app.use(express.json());

const allowedOrigins = [
    'https://badmintonf2.netlify.app/', // URL Netlify/Vercel ของคุณ
    // เพิ่ม URL อื่นๆ ที่อนุญาต เช่น 'http://localhost:8080'
];

app.use(cors({
    origin: (origin, callback) => {
        // อนุญาตถ้า origin อยู่ในรายการที่กำหนด หรือไม่มี origin (เช่น Postman, cURL)
        if (!origin || allowedOrigins.includes(origin) || origin.startsWith('http://localhost')) {
            callback(null, true);
        } else {
            // *** การแก้ไขที่ 4: การจัดการ Error CORS ที่ดีขึ้น ***
            console.warn(`CORS: Origin ${origin} is not allowed.`);
            callback(new Error('Not allowed by CORS'), false);
        }
    },
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    credentials: true
}));

// --- 1. การเชื่อมต่อ Supabase ---
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY, 
    {
        auth: {
            persistSession: false
        }
    }
);

// --- 2. การจัดการไฟล์อัปโหลด ---
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });
const BUCKET_NAME = 'photos'; 

// --- 3. ฟังก์ชันช่วย: อัปโหลดไฟล์ไปที่ Supabase Storage ---
async function uploadToSupabase(file, bucketName, path) {
    if (!file || !file.buffer) {
        throw new Error('File buffer is missing.');
    }
    const fileExt = file.originalname.split('.').pop();
    const fileName = `${path}_${uuidv4()}.${fileExt}`; // ใช้ _ แทน - เพื่อให้อ่านง่ายขึ้น
    
    // อัปโหลด
    const { error } = await supabase.storage
        .from(bucketName)
        .upload(fileName, file.buffer, {
            contentType: file.mimetype,
            upsert: true
        });

    if (error) throw error;
    
    // สร้าง Public URL (Supabase จะให้ URL ที่สมบูรณ์แล้ว)
    const { data: publicUrlData } = supabase.storage
        .from(bucketName)
        .getPublicUrl(fileName);
        
    if (!publicUrlData || !publicUrlData.publicUrl) {
        throw new Error('Could not retrieve public URL for uploaded file.');
    }
        
    return publicUrlData.publicUrl;
}

// --- UTILITY FUNCTIONS สำหรับจัดการ Global Config (ตาราง app_config) ---
const CONFIG_TABLE = 'app_config';

async function getGlobalConfig(key) {
    const { data, error } = await supabase.from(CONFIG_TABLE).select('value').eq('key', key).single();
    if (error && error.code !== 'PGRST116') { 
        console.error(`Error fetching config ${key}:`, error);
        return null;
    }
    return data ? data.value : null;
}

async function setGlobalConfig(key, value) {
    const { error } = await supabase.from(CONFIG_TABLE).upsert({ key: key, value: value }, { onConflict: 'key' });
    if (error) {
        console.error(`Error setting config ${key}:`, error);
        return false;
    }
    return true;
}

// *** ฟังก์ชันใหม่: สร้างรหัสทีมที่รันต่อเนื่อง (ต้องสร้าง Supabase Function ใน DB) ***
// ตัวอย่าง SQL (ต้องสร้างใน Supabase -> Database -> SQL Editor):
/*
CREATE OR REPLACE FUNCTION generate_team_code(level_char char)
RETURNS text AS $$
DECLARE
    next_seq int;
    code text;
BEGIN
    -- สร้าง Sequence ถ้ายังไม่มี
    EXECUTE 'CREATE SEQUENCE IF NOT EXISTS team_seq_' || level_char || ' START 1;';
    
    -- ดึงค่า Sequence ถัดไป
    EXECUTE 'SELECT nextval(''team_seq_' || level_char || ''')' INTO next_seq;
    
    -- สร้างรหัสทีม เช่น SUT25-E001
    code := 'SUT25-' || upper(level_char) || lpad(next_seq::text, 3, '0');
    
    RETURN code;
END;
$$ LANGUAGE plpgsql;
*/
async function generateUniqueTeamCode(level) {
    const { data, error } = await supabase.rpc('generate_team_code', { level_char: level });
    if (error) throw error;
    return data;
}

// --- API Endpoints ---

// A. [PUBLIC] การลงทะเบียนทีมใหม่
app.post('/api/register', upload.fields([{ name: 'p1_photo' }, { name: 'p2_photo' }]), async (req, res) => {
    const { team_name, level, p1_name, p1_id, p1_type, p2_name, p2_id, p2_type, eval_method, eval_link } = req.body;
    
    const p1_photo = req.files && req.files['p1_photo'] ? req.files['p1_photo'][0] : null;
    const p2_photo = req.files && req.files['p2_photo'] ? req.files['p2_photo'][0] : null;

    if (!p1_photo || !p2_photo) {
        return res.status(400).json({ error: 'ต้องอัปโหลดรูปผู้เล่นทั้งสองคน' });
    }

    try {
        // 1. คำนวณค่าสมัคร
        const fee1 = p1_type === 'student' ? 150 : 300;
        const fee2 = p2_type === 'student' ? 150 : 300;
        const total_fee = fee1 + fee2;
        
        // 2. สร้างรหัสทีม (ใช้ฟังก์ชัน RPC เพื่อให้รหัสไม่ซ้ำ/ต่อเนื่อง)
        const team_code = await generateUniqueTeamCode(level.toUpperCase());

        // 3. บันทึกข้อมูลทีม (teams)
        const { data: teamData, error: teamError } = await supabase
            .from('teams')
            .insert({
                team_code,
                team_name,
                level,
                total_fee,
                eval_method,
                eval_link,
                status: '🟡 รอประเมิน'
            })
            .select()
            .single();

        if (teamError) throw teamError;

        const team_id = teamData.id;
        
        // 4. อัปโหลดรูปผู้เล่น (URL ที่ได้เป็น Public URL สมบูรณ์แล้ว)
        const p1_photo_url = await uploadToSupabase(p1_photo, BUCKET_NAME, `p1_${team_code}`);
        const p2_photo_url = await uploadToSupabase(p2_photo, BUCKET_NAME, `p2_${team_code}`);

        // 5. บันทึกข้อมูลผู้เล่น (players)
        const playersData = [
            { team_id, full_name: p1_name, std_staff_id: p1_id, type: p1_type, photo_path: p1_photo_url, is_player_one: true },
            { team_id, full_name: p2_name, std_staff_id: p2_id, type: p2_type, photo_path: p2_photo_url, is_player_one: false },
        ];

        const { error: playersError } = await supabase
            .from('players')
            .insert(playersData);

        if (playersError) throw playersError;
        
        // *** แก้ไข: ลบ team_code ออกจาก response ***
        res.status(200).json({ 
            message: 'ลงทะเบียนสำเร็จ! โปรดใช้ชื่อทีมเพื่อติดตามสถานะ', 
            // team_code ถูกลบออกแล้ว
        });

    } catch (error) {
        console.error('Registration failed:', error);
        res.status(500).json({ error: error.message || 'เกิดข้อผิดพลาดในการลงทะเบียน' });
    }
});


// D. [ADMIN] อัปโหลด QR Code สำหรับการชำระเงิน
app.post('/api/admin/upload-qr', upload.single('qr_code'), async (req, res) => {
    const qrFile = req.file;
    if (!qrFile) {
        return res.status(400).json({ error: 'ไม่พบไฟล์ QR Code' });
    }

    try {
        // 1. อัปโหลดไปยัง Supabase Storage
        const qrUrl = await uploadToSupabase(qrFile, BUCKET_NAME, 'config_qr_code');

        // 2. บันทึก URL ลงใน app_config
        const success = await setGlobalConfig('qr_code_path', qrUrl);
        if (!success) {
            return res.status(500).json({ error: 'บันทึก URL ลง Database ไม่สำเร็จ' });
        }

        res.status(200).json({ message: 'อัปโหลด QR Code สำเร็จ', url: qrUrl });
    } catch (error) {
        console.error('QR Upload Error:', error);
        res.status(500).json({ error: 'เกิดข้อผิดพลาดในการอัปโหลด QR Code: ' + error.message });
    }
});

// E. [ADMIN] ดึง Path QR Code ปัจจุบัน
app.get('/api/config/qr_code_path', async (req, res) => {
    try {
        const qr_code_path = await getGlobalConfig('qr_code_path');
        
        if (!qr_code_path) {
            return res.status(404).json({ error: 'ไม่พบ QR Code ในระบบ' });
        }

        res.status(200).json({ qr_code_path });
    } catch (error) {
        res.status(500).json({ error: 'เกิดข้อผิดพลาดในการดึง QR Code Path' });
    }
});

// G. [PUBLIC] อัปโหลด Slip โอนเงิน
app.post('/api/upload-slip/:teamCode', upload.single('slip'), async (req, res) => {
    const teamCode = req.params.teamCode.toUpperCase();
    const slipFile = req.file;

    if (!slipFile) {
        return res.status(400).json({ error: 'ไม่พบไฟล์ Slip โอนเงิน' });
    }

    try {
        // 1. ตรวจสอบสถานะทีมก่อน
        const { data: team, error: selectError } = await supabase
            .from('teams')
            .select('status, id')
            .eq('team_code', teamCode)
            .single();

        if (selectError || !team) {
            return res.status(404).json({ error: 'ไม่พบรหัสทีม' });
        }
        
        if (team.status !== '✅ ผ่านการประเมิน') {
            return res.status(403).json({ error: 'ทีมยังไม่ผ่านการประเมินมือ กรุณารอ Admin ดำเนินการ' });
        }

        // 2. อัปโหลด Slip ไปที่ Storage
        const slipUrl = await uploadToSupabase(slipFile, BUCKET_NAME, `slip_${teamCode}`);
        
        // 3. อัปเดตสถานะทีม
        const { error: updateError } = await supabase
            .from('teams')
            .update({ 
                slip_path: slipUrl, 
                status: '🔵 รอตรวจสอบการโอนเงิน' 
            })
            .eq('id', team.id);

        if (updateError) throw updateError;

        res.status(200).json({ message: 'อัปโหลด Slip สำเร็จ! ทีมของคุณเปลี่ยนสถานะเป็น "รอตรวจสอบการโอนเงิน"' });

    } catch (error) {
        console.error('Slip Upload Error:', error);
        res.status(500).json({ error: 'เกิดข้อผิดพลาดในการอัปโหลด Slip: ' + error.message });
    }
});


// F. [PUBLIC] ดึงข้อมูลสถานะทีม (รวม QR Code Path)
app.get('/api/status/name/:teamName', async (req, res) => {
    const teamName = req.params.teamName;
    try {
        const { data: teamData, error } = await supabase
            .from('teams')
            .select(`
                *,
                players (full_name, std_staff_id, type, photo_path, is_player_one)
            `)
            .eq('team_name', teamName)
            .single(); // ดึงข้อมูลเดียวเท่านั้น

        if (error || !teamData) {
            return res.status(404).json({ error: 'ไม่พบทีมชื่อนี้' });
        }

        let qr_code_path = null;
        // 1. Admin อัปโหลด QR Code จะไปแสดงอัตโนมัติสำหรับทีมที่ผ่าน
        if (teamData.status === '✅ ผ่านการประเมิน') { 
             qr_code_path = await getGlobalConfig('qr_code_path'); 
        }

        // *** การแก้ไขที่ 3: qr_code_path ที่ส่งไปคือ Public URL สมบูรณ์แล้ว ***
        res.status(200).json({ team: teamData, qr_code_path: qr_code_path }); 

    } catch (error) {
        console.error('Status Check by Name Error:', error);
        res.status(500).json({ error: 'เกิดข้อผิดพลาดในการตรวจสอบสถานะ: ' + error.message });
    }
});


// F2. [PUBLIC] ดึงข้อมูลสถานะทีมด้วย 'รหัสทีม' (ยังคงไว้เผื่อจำเป็น)
app.get('/api/status/:teamCode', async (req, res) => {
    const teamCode = req.params.teamCode.toUpperCase();
    try {
        const { data: teamData, error } = await supabase
            .from('teams')
            .select(`
                *,
                players (full_name, std_staff_id, type, photo_path, is_player_one)
            `)
            .eq('team_code', teamCode)
            .single();

        if (error || !teamData) {
            return res.status(404).json({ error: 'ไม่พบรหัสทีม' });
        }

        let qr_code_path = null;
        if (teamData.status === '✅ ผ่านการประเมิน') { 
             qr_code_path = await getGlobalConfig('qr_code_path'); 
        }

        res.status(200).json({ team: teamData, qr_code_path: qr_code_path }); 

    } catch (error) {
        console.error('Status Check by Code Error:', error);
        res.status(500).json({ error: 'เกิดข้อผิดพลาดในการตรวจสอบสถานะ: ' + error.message });
    }
});


// B. [ADMIN] ดึงรายชื่อทีมทั้งหมด (สำหรับ Dashboard)
app.get('/api/admin/teams', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('teams')
            .select('*')
            .order('created_at', { ascending: false });

        if (error) throw error;

        res.status(200).json({ teams: data });
    } catch (error) {
        console.error('Admin Fetch Teams Error:', error);
        res.status(500).json({ error: 'เกิดข้อผิดพลาดในการดึงข้อมูลทีมทั้งหมด' });
    }
});

// C. [ADMIN] ดึงรายละเอียดทีมและผู้เล่น (สำหรับ Modal)
app.get('/api/admin/team-details/:teamId', async (req, res) => {
    const teamId = req.params.teamId;
    try {
        const { data, error } = await supabase
            .from('teams')
            .select(`
                *,
                players (full_name, std_staff_id, type, photo_path, is_player_one)
            `)
            .eq('id', teamId)
            .single();

        if (error || !data) {
            return res.status(404).json({ error: 'ไม่พบรหัสทีม' });
        }

        res.status(200).json({ team: data });
    } catch (error) {
        console.error('Admin Fetch Team Details Error:', error);
        res.status(500).json({ error: 'เกิดข้อผิดพลาดในการดึงรายละเอียดทีม' });
    }
});

// H. [ADMIN] การจัดการสถานะทีม
app.post('/api/admin/update-status', async (req, res) => {
    const { team_id, new_status } = req.body;
    
    try {
        const { error } = await supabase
            .from('teams')
            .update({ status: new_status })
            .eq('id', team_id);
            
        if (error) throw error;
        
        res.status(200).json({ message: `อัปเดตสถานะทีม ${team_id} เป็น ${new_status} สำเร็จ` });

    } catch (error) {
        console.error('Admin Update Status Error:', error);
        res.status(500).json({ error: 'เกิดข้อผิดพลาดในการอัปเดตสถานะ' });
    }
});

// J. [PUBLIC] ดึงจำนวนทีมตามรุ่นและสถานะ (สำหรับหน้าหลัก)
app.get('/api/team-count-by-level', async (req, res) => {
    try {
        // ดึงข้อมูลทั้งหมดที่จำเป็น (level, status)
        const { data, error } = await supabase
            .from('teams')
            .select('level, status'); 

        if (error) throw error;

        // จัดกลุ่มข้อมูลใน JavaScript
        const teamCounts = {};
        const allLevels = ['A', 'B', 'C', 'D', 'E']; // กำหนด Levels ที่สนใจ
        
        // เตรียมโครงสร้างเริ่มต้น
        allLevels.forEach(level => {
            teamCounts[level] = { total: 0, passed: 0 };
        });

        // ประมวลผลข้อมูล
        data.forEach(team => {
            const level = team.level;
            if (teamCounts[level]) { // ตรวจสอบว่า Level นี้อยู่ใน Levels ที่กำหนดหรือไม่
                teamCounts[level].total++;
                if (team.status === '✅ ผ่านการประเมิน' || team.status === '🟢 ชำระเงินแล้ว' || team.status === '🔵 รอตรวจสอบการโอนเงิน') {
                    teamCounts[level].passed++; // นับรวมสถานะที่ 'ผ่าน' การคัดเลือกมือแล้ว
                }
            }
        });

        // จัดรูปแบบผลลัพธ์ให้อยู่ใน array
        const result = Object.keys(teamCounts).map(level => ({
            level: level,
            total: teamCounts[level].total,
            passed: teamCounts[level].passed
        }));

        res.status(200).json({ counts: result });

    } catch (error) {
        console.error('Team Count By Level Error:', error);
        res.status(500).json({ error: 'Failed to count teams by level.' });
    }
});

// --- เริ่มต้น Server ---
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});