import test from 'node:test';
import assert from 'node:assert/strict';
import { newsLink } from './datageoTicker.js';

test('newsLink abre a página fonte da notícia em nova aba', () => {
  const link = newsLink({ url: 'https://www.bemparana.com.br/noticia/x', source: 'Bem Paraná' });
  assert.deepEqual(link, {
    href: 'https://www.bemparana.com.br/noticia/x',
    title: 'Abrir a notícia em Bem Paraná (nova aba)',
  });
});

test('newsLink aceita http e links de redirecionamento do Google News', () => {
  assert.equal(newsLink({ url: 'http://exemplo.pr.gov.br/a' }).href, 'http://exemplo.pr.gov.br/a');
  const gnews = 'https://news.google.com/rss/articles/CBMi?oc=5';
  assert.equal(newsLink({ url: gnews }).href, gnews);
});

test('newsLink recusa esquemas que executam código ou não são páginas', () => {
  for (const url of [
    'javascript:alert(1)',
    ' JavaScript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    '//sem-esquema.com/x',
    '/relativo',
    'nao é url',
    '',
    null,
    undefined,
    42,
  ]) {
    assert.equal(newsLink({ url }), null, String(url));
  }
  assert.equal(newsLink(null), null);
});

test('newsLink sem fonte usa um título genérico', () => {
  assert.equal(newsLink({ url: 'https://a.com/b' }).title, 'Abrir a notícia na página fonte (nova aba)');
  assert.equal(newsLink({ url: 'https://a.com/b', source: '  ' }).title, 'Abrir a notícia na página fonte (nova aba)');
});
