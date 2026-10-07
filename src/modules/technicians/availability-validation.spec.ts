import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateTimeOffDto, UpdateScheduleDto, UpdateServiceAreasDto } from './dto/availability.dto';
import { SavePersonalInfoDto } from './dto/onboarding.dto';
import { UpdateProfileDto } from '../users/dto/update-profile.dto';
import { AnalyzeDto, AskDto } from '../ai-diagnosis/dto/ai-contract.dto';

const failing = async (cls: new () => object, body: object): Promise<string[]> => {
  const errors = await validate(plainToInstance(cls, body) as object);
  const walk = (list: typeof errors, prefix = ''): string[] =>
    list.flatMap((e) => (e.children?.length ? walk(e.children, `${prefix}${e.property}.`) : [`${prefix}${e.property}`]));
  return walk(errors);
};

describe('Technician schedule', () => {
  it('accepts what web and mobile send', async () => {
    expect(await failing(UpdateScheduleDto, { schedules: [{ dayOfWeek: 1, startTime: '08:00', endTime: '17:00' }] })).toEqual([]);
    expect(await failing(UpdateScheduleDto, { schedules: [] })).toEqual([]);
  });

  it.each([
    [{ dayOfWeek: 7, startTime: '08:00', endTime: '17:00' }, 'schedules.0.dayOfWeek'],
    [{ dayOfWeek: 1, startTime: '08:00:00', endTime: '17:00' }, 'schedules.0.startTime'],
    [{ dayOfWeek: 1, startTime: 'zz:zz', endTime: '17:00' }, 'schedules.0.startTime'],
    [{ dayOfWeek: 1, startTime: '08:00', endTime: '24:00' }, 'schedules.0.endTime'],
    [{ dayOfWeek: 1, startTime: '08:00' }, 'schedules.0.endTime'],
  ])('rejects %j', async (item, field) => {
    expect(await failing(UpdateScheduleDto, { schedules: [item] })).toEqual([field]);
  });

  it('rejects a missing list', async () => {
    expect(await failing(UpdateScheduleDto, {})).toEqual(['schedules']);
  });
});

describe('Service areas and time off', () => {
  it('bounds area codes to the column width', async () => {
    expect(await failing(UpdateServiceAreasDto, { areas: [{ provinceCode: '79', districtCode: '760' }] })).toEqual([]);
    expect(await failing(UpdateServiceAreasDto, { areas: [{ provinceCode: '7'.repeat(51), districtCode: '760' }] })).toEqual(['areas.0.provinceCode']);
  });

  it('needs real dates and a short reason', async () => {
    expect(await failing(CreateTimeOffDto, { startAt: '2026-10-20T00:00:00+07:00', endAt: '2026-10-21T00:00:00+07:00', reason: 'Việc gia đình' })).toEqual([]);
    expect(await failing(CreateTimeOffDto, { startAt: 'mai', endAt: '2026-10-21T00:00:00+07:00' })).toEqual(['startAt']);
    expect(await failing(CreateTimeOffDto, { startAt: '2026-10-20T00:00:00+07:00', endAt: '2026-10-21T00:00:00+07:00', reason: 'x'.repeat(501) })).toEqual(['reason']);
  });
});

describe('Names, experience and avatar', () => {
  it('applies the registration name rule to the profile and onboarding', async () => {
    expect(await failing(UpdateProfileDto, { fullName: 'Nguyễn Thị Ánh' })).toEqual([]);
    expect(await failing(UpdateProfileDto, { fullName: '<b>Admin</b>' })).toEqual(['fullName']);
    expect(await failing(UpdateProfileDto, { fullName: 'An 😀' })).toEqual(['fullName']);
    const personal = { fullName: 'Trần Văn B 123', dateOfBirth: '1995-05-15', gender: 'male', citizenIdNumber: '012345678901', phoneNumber: '0912345678' };
    expect(await failing(SavePersonalInfoDto, personal)).toContain('fullName');
  });

  it('takes whole years of experience', async () => {
    const errors = await validate(plainToInstance((await import('./dto/onboarding.dto')).SaveSkillsDto, { serviceIds: ['11111111-1111-4111-8111-111111111111'], yearsExperience: 2.5 }));
    expect(errors.map((e) => e.property)).toContain('yearsExperience');
  });

  it('keeps a hosted avatar and refuses a device path', async () => {
    expect(await failing(UpdateProfileDto, { avatarUrl: 'https://xyz.supabase.co/storage/v1/object/public/avatars/a.jpg' })).toEqual([]);
    expect(await failing(UpdateProfileDto, { avatarUrl: 'http://localhost:3000/api/v1/media/a.jpg' })).toEqual([]);
    expect(await failing(UpdateProfileDto, { avatarUrl: 'file:///data/user/0/host.exp.exponent/cache/a.jpg' })).toEqual(['avatarUrl']);
  });
});

describe('AI limits match the AI Service', () => {
  it('stops a description or question the AI Service would refuse', async () => {
    expect(await failing(AnalyzeDto, { description: 'a'.repeat(2000) })).toEqual([]);
    expect(await failing(AnalyzeDto, { description: 'a'.repeat(2001) })).toEqual(['description']);
    expect(await failing(AskDto, { question: 'a'.repeat(1001) })).toEqual(['question']);
    expect(await failing(AskDto, { question: 'máy lạnh', sessionId: 's'.repeat(65) })).toEqual(['sessionId']);
  });
});
