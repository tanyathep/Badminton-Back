const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { createClient } = require('@supabase/supabase-js');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid'); // ไม่จำเป็นต้องใช้ uuidv4 แต่ยังคงไว้หากต้องการ

dotenv.config();
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// --- 1. การเชื่อมต่อ Supabase ---
// *** ตรวจสอบให้แน่ใจว่าได้ตั้งค่า SUPABASE_URL และ SUPABASE_SERVICE_KEY ในไฟล์ .env ***
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY, // ต้องใช้ Service Role Key เพื่อให้ Server มีสิทธิ์เต็มที่
    {
        auth: {
            persistSession: false
        }
    }
);

// --- 2. การจัดการไฟล์อัปโหลด ---
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });
const BUCKET_NAME = 'photos'; // *** กำหนดชื่อ Bucket ที่แน่นอนสำหรับรูปภาพ, QR, และ Slip ***

// --- 3. ฟังก์ชันช่วย: อัปโหลดไฟล์ไปที่ Supabase Storage ---
async function uploadToSupabase(file, bucketName, path) {
    if (!file || !file.buffer) {
        throw new Error('File buffer is missing.');
    }
    const fileExt = file.originalname.split('.').pop();
    // ใช้ UUID เพื่อให้แน่ใจว่าชื่อไฟล์ไม่ซ้ำกันจริง ๆ
    const fileName = `${path}-${uuidv4()}.${fileExt}`;
    
    const { error } = await supabase.storage
        .from(bucketName)
        .upload(fileName, file.buffer, {
            contentType: file.mimetype,
            upsert: true
        });

    if (error) throw error;
    
    // สร้าง Public URL
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
    if (error && error.code !== 'PGRST116') { // PGRST116 คือไม่พบ row
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
        
        // 2. สร้างรหัสทีม (SUT25-E001)
        const team_num = String(Math.floor(Math.random() * 9000) + 1000).substring(0, 4);
        const team_code = `SUT25-${level.toUpperCase()}${team_num}`; // แปลง level เป็นตัวพิมพ์ใหญ่เผื่อไว้ก่อน

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
        
        // 4. อัปโหลดรูปผู้เล่น
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
        
        res.status(200).json({ 
            message: 'ลงทะเบียนสำเร็จ! โปรดใช้รหัสทีมเพื่อติดตามสถานะ', 
            team_code: team_code 
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

app.get('/api/team-count-by-level', async (req, res) => {
    try {
        // ใช้ Supabase PostgREST aggregation (group by และ count)
        const { data, error } = await supabase
            .from('teams')
            .select('level, status', { count: 'exact' }); 

        if (error) throw error;

        // จัดกลุ่มข้อมูลใน JavaScript
        const teamCounts = {};
        data.forEach(team => {
            const level = team.level;
            if (!teamCounts[level]) {
                teamCounts[level] = { total: 0, passed: 0 };
            }
            teamCounts[level].total++;
            if (team.status === '✅ ผ่านการประเมิน' || team.status === '🟢 ชำระเงินแล้ว' || team.status === '🔵 รอตรวจสอบการโอนเงิน') {
                teamCounts[level].passed++; // นับรวมสถานะที่ 'ผ่าน' การคัดเลือกมือแล้ว
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