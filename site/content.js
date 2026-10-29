export const adminEmails = ['eric.scorp93@gmail.com', 'tuanpham.x93@gmail.com'];
export const isAdmin = user => !!user?.emailVerified && user.isAdmin === true;
export const projects = [
 {id:'ticket',category:'Web',name:'TICKET Ticket',subtitle:'Production feedback, tickets and team visibility',status:'Live',year:'2026',icon:'▤',description:'A working TICKET feedback and incident portal with mobile photo/video reporting, ticket progress and comments, department dashboards, administrator-managed accounts and configurable content widgets. Built with Node.js and PostgreSQL, deployed on Raspberry Pi, and available as an independent application.',tags:['TICKET','Node.js','PostgreSQL','Mobile feedback'],url:'https://ticket.th.io.vn',source:'https://github.com/TuanPham0411/Thien-Ha/tree/ticket-standalone'},
 {id:'esp32',category:'Embedded',name:'ESP32 AI Assistant',subtitle:'Hardware meets conversational AI',status:'In development',year:'2026',icon:'◈',description:'A personal chatbot assistant built around an ESP32 development board. An ongoing exploration of embedded hardware, interaction design and AI integration.',tags:['ESP32','Embedded systems','AI'],url:'https://thienha.io.vn/projects/xiaozhi-esp32'},
 {id:'learning',category:'Web',name:'Educational Games',subtitle:'Interactive learning for children',status:'In development',year:'2026',icon:'⌘',description:'A web-based learning platform for children, using visual and audio interactions to support age-appropriate skills. This is a personal project currently in development.',tags:['Web development','Learning','Interaction'],url:'https://thienha.io.vn/projects/game-of-thien'}
];
export const experience = [
 ['Jul 2026 — Present','Operational Technical Engineer','Pepperl+Fuchs Vietnam','Production network troubleshooting, TICKET transfer support, software support, documentation and collaboration with Global OT and Vietnam IT.'],
 ['Mar 2025 — Jul 2026','Operational Technical Support Engineer','Pepperl+Fuchs Vietnam','Investigated production system incidents, supported line software and coordinated remote technical analysis with OT and IT teams.'],
 ['Jun 2023 — Mar 2025','Senior Assistant Test Engineer','Pepperl+Fuchs Vietnam','Planned plant-wide calibration, analyzed test equipment issues and developed tools to retrieve and assess test data.'],
 ['Apr 2022 — Jul 2023','Assistant Test Engineer','Pepperl+Fuchs Vietnam','Equipment calibration, maintenance and software-assisted improvements to quality, performance and task execution.'],
 ['Sep 2019 — Apr 2022','Technician','Pepperl+Fuchs Vietnam','Maintained production equipment and supported operational continuity through repair and scheduled maintenance.'],
 ['Oct 2016 — Sep 2019','Apprentice · TGA dual training','Bosch Vietnam','Full-scholarship apprenticeship with Lilama 2, building a foundation in mechatronics, PLC programming and industrial problem solving.']
];
export {validInquiry} from '../server/inquiry.js';
