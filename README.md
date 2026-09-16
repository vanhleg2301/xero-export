# xero-export

Công cụ chạy trên máy cá nhân để kéo toàn bộ dữ liệu kế toán từ Xero về, xem lại bằng giao diện web giống Xero, và xuất ra CSV kèm file đính kèm.

Không có gì chạy trên server ngoài: dữ liệu lưu trong thư mục `data/` trên máy bạn, web server chỉ nghe ở `127.0.0.1`.

## Cần chuẩn bị

- Node.js 20 trở lên.
- Một app trên [Xero Developer](https://developer.xero.com/app/manage), loại **Web app**, với redirect URI `http://localhost:3000/callback`.

## Cài đặt

```bash
npm install
cp .env.example .env
```

Điền `XERO_CLIENT_ID` và `XERO_CLIENT_SECRET` (lấy ở tab Configuration của app) vào `.env`.

`.env`, `tokens.json`, `data/` và `export/` đều nằm trong `.gitignore`, không bị đẩy lên git.

## Chạy

```bash
npm run viewer
```

Mở http://localhost:3000. Toàn bộ thao tác nằm trên giao diện:

1. **Kết nối & đồng bộ → Kết nối Xero**: đăng nhập, chọn tổ chức.
2. **Bắt đầu đồng bộ**: kéo dữ liệu về. Tùy chọn tải kèm file đính kèm, hoặc lấy lại toàn bộ dữ liệu mới nhất.
3. **Tải dữ liệu về máy**, ba dạng:
   - `.zip`: CSV theo định dạng Xero + thư mục `attachments/`. Mỗi mục (Bills, Invoices...) cũng có nút tải riêng.
   - `.html`: một file duy nhất, mở bằng trình duyệt, bấm vào dòng là hiện luôn PDF/ảnh đính kèm. Không cần giải nén, gửi cho người khác xem được ngay.
   - `.xlsx`: mỗi loại dữ liệu một sheet, ảnh nhúng thẳng vào dòng, PDF là link bấm mở (link chỉ chạy khi file xlsx nằm cạnh thư mục `attachments/` đã giải nén).

Cổng 3000 là bắt buộc vì phải khớp redirect URI đã khai báo với Xero.

## Các lệnh

| Lệnh | Việc |
|---|---|
| `npm run viewer` | Bật giao diện web ở http://localhost:3000 |
| `npm run auth` | Đăng nhập Xero từ terminal |
| `npm run export` | Đồng bộ dữ liệu, chỉ lấy mục chưa có |
| `npm run export -- --attachments` | Đồng bộ kèm tải file đính kèm |
| `npm run export -- --refresh --attachments` | Lấy lại toàn bộ dữ liệu mới nhất |
| `npm run csv` | Xuất CSV, file .html, file .xlsx và file đính kèm ra thư mục `export/` |
| `npm run typecheck` | Kiểm tra lỗi TypeScript |

## Cấu trúc thư mục

```
src/
  server.ts      web server: OAuth, tác vụ đồng bộ, API, đóng gói zip
  exporter.ts    gọi Xero API, phân trang, giới hạn tốc độ, tải đính kèm
  xero.ts        OAuth, refresh token, HTTP client
  dataStore.ts   đọc dữ liệu đã tải, dựng bộ file để xuất
  xeroFormat.ts  đổi JSON của Xero sang CSV theo cột kiểu Xero
  htmlReport.ts  dựng file .html tự chứa, nhúng sẵn file đính kèm
  excelReport.ts dựng workbook từ dữ liệu đã xuất
  xlsx.ts        ghi file .xlsx (tự sinh, không dùng thư viện ngoài)
  views.ts       danh sách mục hiển thị trên giao diện
  csvTables.ts   tiện ích CSV
  zip.ts         ghi file zip (dùng zlib có sẵn của Node)
public/          giao diện web (HTML/CSS/JS thuần, không build)
data/            dữ liệu JSON và file đính kèm tải về
export/          kết quả của `npm run csv`
```

## Dữ liệu lấy được

Organisation, Accounts, TaxRates, TrackingCategories, Currencies, BrandingThemes, Users, Contacts, ContactGroups, Items, Invoices (cả hóa đơn bán và bill), CreditNotes, Quotes, PurchaseOrders, RepeatingInvoices, Payments, Prepayments, Overpayments, BatchPayments, BankTransactions, BankTransfers, ManualJournals, LinkedTransactions, Budgets, Trial Balance, Balance Sheet, và file đính kèm của từng chứng từ.

## Định dạng file xuất ra

CSV làm theo kiểu file export của Xero: mỗi dòng hàng là một dòng CSV, ngày dạng `dd/mm/yyyy`, mã thuế đổi sang tên thuế, trạng thái ghi như trên Xero (`Awaiting Payment`).

Ba cách để biết file đính kèm thuộc chứng từ nào:

- Tên file có sẵn số chứng từ và tên đối tác: `attachments/Bills/PTDK 5 - PEJABAT TANAH DAERAH KLUANG - PERMIT.jpeg`.
- `Attachments.csv` liệt kê từng file kèm số chứng từ, đối tác, ngày, số tiền, trạng thái và link mở file.
- Hai cột `AttachmentCount` và `AttachmentFiles` ở cuối mỗi dòng trong CSV chính.

## Giới hạn

- **Journals**: app mới không xin được scope `accounting.journals.read`; endpoint này trả về 401. Muốn lấy phải đăng ký gói Advanced và được Xero duyệt.
- **Tốc độ**: Xero cho 60 lượt gọi/phút và 5.000 lượt/ngày cho mỗi tổ chức. Script tự giãn nhịp và chờ khi bị chặn. Nếu chạm giới hạn ngày, chạy lại hôm sau, phần đã tải được giữ nguyên.
- **Không lấy được qua API**: dòng sao kê ngân hàng thô, trạng thái đối soát chi tiết, mẫu hóa đơn, file trong thư viện Files chưa gắn vào chứng từ.
- **Phiên đăng nhập**: refresh token hết hạn sau 60 ngày không dùng, khi đó bấm "Kết nối lại".
- Điều khoản của Xero cấm dùng dữ liệu API để train hoặc fine-tune mô hình AI.
