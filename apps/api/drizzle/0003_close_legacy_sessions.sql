-- Бои вертикального среза (этап 1) хранились в старом формате состояния: закрываем их.
UPDATE "sessions" SET "state" = 'ended', "ended_reason" = 'legacy', "ended_at" = now() WHERE "scenario_id" = 'slice_cellar' AND "state" = 'active';
