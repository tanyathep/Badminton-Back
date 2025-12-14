-- ต้องรันทีละตาราง
-- ตาราง 1: teams
CREATE TABLE teams (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_code TEXT UNIQUE NOT NULL,                       -- SUT25-E001
    team_name TEXT NOT NULL,
    level CHAR(1) NOT NULL,                               -- A, B, C, D, E
    status TEXT NOT NULL DEFAULT '🟡 รอประเมิน',            -- สถานะการสมัคร
    total_fee NUMERIC(5, 0) NOT NULL,
    eval_method TEXT,                                     -- clip, onsite
    eval_link TEXT,                                       -- Link คลิปประเมิน
    slip_path TEXT,                                       -- Path/URL Slip โอนเงินใน Storage
    created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW()
);

-- ตาราง 2: players
CREATE TABLE players (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id UUID REFERENCES teams(id) ON DELETE CASCADE,  -- เชื่อมกับทีม
    full_name TEXT NOT NULL,
    std_staff_id TEXT NOT NULL,                           -- รหัสนศ./รหัสพนักงาน
    type TEXT NOT NULL,                                   -- student, staff
    photo_path TEXT,                                      -- Path/URL รูปผู้เล่นใน Storage
    is_player_one BOOLEAN NOT NULL
);

-- ตาราง 3: settings
CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT
);

-- ตาราง 4: admin_users (ใช้สำหรับเก็บ user ที่สร้างผ่าน Supabase Auth)
-- (ตารางนี้จะจัดการผ่าน Supabase Auth โดยตรง ไม่ต้องสร้างใน SQL Editor แต่เตรียมไว้ใน Logic)

-- ตัวอย่างการใส่ค่าเริ่มต้นใน Settings
INSERT INTO settings (key, value) VALUES 
('qr_code_path', 'assets/qr_code_default.png'), -- Path ใน Supabase Storage Bucket
('max_teams', '32');