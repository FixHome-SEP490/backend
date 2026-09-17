// src/modules/mail/mail.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private transporter: Transporter | null = null;

  constructor(private readonly configService: ConfigService) {
    this.initTransporter();
  }

  private initTransporter(): void {
    const host = this.configService.get<string>('MAIL_HOST', 'smtp.gmail.com');
    const port = Number(this.configService.get<number>('MAIL_PORT', 587));
    const user = this.configService.get<string>('MAIL_USERNAME');
    const pass = this.configService.get<string>('MAIL_PASSWORD');

    if (!user || !pass) {
      this.logger.warn(
        'Mail credentials (MAIL_USERNAME/MAIL_PASSWORD) are not fully configured. Email sending will be mocked in logs.',
      );
      return;
    }

    this.transporter = nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: {
        user,
        pass,
      },
    });
  }

  private getFromAddress(): string {
    const from = this.configService.get<string>('MAIL_FROM');
    const user = this.configService.get<string>('MAIL_USERNAME');
    return from || `FixHome <${user || 'noreply@fixhome.vn'}>`;
  }

  async sendRegisterOtp(
    to: string,
    otp: string,
    recipientName?: string,
  ): Promise<void> {
    const subject = `[FixHome] Mã xác thực đăng ký tài khoản: ${otp}`;
    const name = recipientName ? recipientName.trim() : 'Quý khách';
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f4f6f9; margin: 0; padding: 20px; color: #333; }
          .container { max-width: 540px; margin: 0 auto; background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.08); }
          .header { background: linear-gradient(135deg, #1e3a8a, #3b82f6); padding: 30px 20px; text-align: center; color: #ffffff; }
          .header h1 { margin: 0; font-size: 24px; font-weight: 700; letter-spacing: 0.5px; }
          .content { padding: 30px 25px; line-height: 1.6; }
          .otp-box { margin: 25px 0; text-align: center; }
          .otp-code { display: inline-block; font-size: 36px; font-weight: 800; letter-spacing: 8px; color: #1e3a8a; background: #eff6ff; padding: 14px 28px; border-radius: 8px; border: 2px dashed #3b82f6; }
          .note { font-size: 13px; color: #64748b; margin-top: 20px; }
          .footer { background: #f8fafc; padding: 18px 25px; text-align: center; font-size: 12px; color: #94a3b8; border-top: 1px solid #e2e8f0; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>FixHome</h1>
            <p style="margin: 5px 0 0; opacity: 0.9; font-size: 14px;">Nền tảng Dịch vụ Sửa chữa & Bảo trì Gia đình</p>
          </div>
          <div class="content">
            <p>Xin chào <strong>${name}</strong>,</p>
            <p>Cảm ơn bạn đã đăng ký tài khoản tại FixHome. Để hoàn tất kích hoạt tài khoản, vui lòng nhập mã OTP xác thực dưới đây:</p>
            <div class="otp-box">
              <div class="otp-code">${otp}</div>
            </div>
            <p class="note">⚠️ <strong>Lưu ý:</strong> Mã OTP có hiệu lực trong vòng <strong>5 phút</strong>. Vì lý do an toàn, tuyệt đối không chia sẻ mã này cho bất kỳ ai khác.</p>
          </div>
          <div class="footer">
            <p style="margin: 0;">Email này được gửi tự động từ hệ thống FixHome. Vui lòng không trả lời thư này.</p>
          </div>
        </div>
      </body>
      </html>
    `;

    await this.sendMail(to, subject, html);
  }

  async sendPasswordResetOtp(
    to: string,
    otp: string,
    recipientName?: string,
  ): Promise<void> {
    const subject = `[FixHome] Yêu cầu đặt lại mật khẩu: ${otp}`;
    const name = recipientName ? recipientName.trim() : 'Quý khách';
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f4f6f9; margin: 0; padding: 20px; color: #333; }
          .container { max-width: 540px; margin: 0 auto; background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.08); }
          .header { background: linear-gradient(135deg, #b91c1c, #ef4444); padding: 30px 20px; text-align: center; color: #ffffff; }
          .header h1 { margin: 0; font-size: 24px; font-weight: 700; letter-spacing: 0.5px; }
          .content { padding: 30px 25px; line-height: 1.6; }
          .otp-box { margin: 25px 0; text-align: center; }
          .otp-code { display: inline-block; font-size: 36px; font-weight: 800; letter-spacing: 8px; color: #b91c1c; background: #fef2f2; padding: 14px 28px; border-radius: 8px; border: 2px dashed #ef4444; }
          .note { font-size: 13px; color: #64748b; margin-top: 20px; }
          .footer { background: #f8fafc; padding: 18px 25px; text-align: center; font-size: 12px; color: #94a3b8; border-top: 1px solid #e2e8f0; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>FixHome</h1>
            <p style="margin: 5px 0 0; opacity: 0.9; font-size: 14px;">Yêu cầu Đặt lại Mật khẩu</p>
          </div>
          <div class="content">
            <p>Xin chào <strong>${name}</strong>,</p>
            <p>Chúng tôi nhận được yêu cầu đặt lại mật khẩu cho tài khoản liên kết với email này. Vui lòng sử dụng mã OTP dưới đây để xác nhận đổi mật khẩu mới:</p>
            <div class="otp-box">
              <div class="otp-code">${otp}</div>
            </div>
            <p class="note">⚠️ <strong>Lưu ý:</strong> Mã OTP có hiệu lực trong vòng <strong>5 phút</strong>. Nếu bạn không thực hiện yêu cầu này, vui lòng bỏ qua email hoặc liên hệ với hỗ trợ FixHome ngay lập tức.</p>
          </div>
          <div class="footer">
            <p style="margin: 0;">Email này được gửi tự động từ hệ thống FixHome. Vui lòng không trả lời thư này.</p>
          </div>
        </div>
      </body>
      </html>
    `;

    await this.sendMail(to, subject, html);
  }

  private async sendMail(to: string, subject: string, html: string): Promise<void> {
    if (!this.transporter) {
      this.logger.log(
        `[MOCK_MAIL] To: ${to} | Subject: ${subject} | (Transporter not configured, skipping actual SMTP send)`,
      );
      return;
    }

    try {
      const info = await this.transporter.sendMail({
        from: this.getFromAddress(),
        to,
        subject,
        html,
      });
      this.logger.log(`Email sent successfully to ${to}, messageId: ${info.messageId}`);
    } catch (error) {
      this.logger.error(`Failed to send email to ${to}: ${(error as Error).message}`, (error as Error).stack);
      // We don't crash the entire request if email fails, but we log the error
      throw error;
    }
  }
}
