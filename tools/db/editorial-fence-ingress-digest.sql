\set ON_ERROR_STOP on
-- Independent PostgreSQL implementation of the actual Editorial-013 digest.
-- Same synthetic artifact as editorial-ingress.spec.ts.
DO $$
DECLARE artifact jsonb := jsonb_build_object(
  'title','Заголовок',
  'parts',jsonb_build_array(
    E'Первый «текст» 😀\nСтрока "цитата" и \\ путь',
    E'Второй\tтекст', E'Третий\nфинал'));
BEGIN
  IF encode(sha256(convert_to(artifact::text,'UTF8')),'hex')
     <> '718025e8f4c2b602bfaf1605f6c9183ee8b5edb60382b6cb929d3ca518f1e840' THEN
    RAISE EXCEPTION 'Editorial-013 digest fixture mismatch';
  END IF;
END $$;
SELECT 'POSTMILL_EDITORIAL_INGRESS_DIGEST_OK';
