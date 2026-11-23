{
  const N = typeof Names !== 'undefined' ? Names : require('../names.js');
  N.add('id', {
    adj: [
      'Biru', 'Merah', 'Emas', 'Perak', 'Gesit',
      'Hening', 'Berani', 'Cerdik', 'Beruntung', 'Tenang',
      'Ceria', 'Lembut', 'Gagah', 'Cerah', 'Perkasa',
      'Bijak', 'Bahagia', 'Nyaman', 'Cepat', 'Bangga',
      'Segar', 'Berkabut', 'Bersalju', 'Badai', 'Ambar',
      'Delima', 'Giok', 'Beludru', 'Tembaga', 'Gading',
      'Mawar', 'Lincah', 'Sabar', 'Pemberani', 'Sopan',
      'Bersahaja', 'Tajam', 'Teguh', 'Anggun', 'Cekatan'
    ],
    noun: [
      'Rajawali', 'Alap-alap', 'Rubah', 'Serigala', 'Beruang',
      'Lynx', 'Rusa', 'Kelinci', 'Burung Hantu', 'Angsa',
      'Jenjang', 'Bangau', 'Pipit', 'Layang-layang', 'Bulbul',
      'Lumba-lumba', 'Berang-berang', 'Kura-kura', 'Gazel', 'Panter',
      'Harimau', 'Singa', 'Kuda', 'Unta', 'Kambing',
      'Domba', 'Kerbau', 'Merpati', 'Elang', 'Gagak',
      'Kuntul', 'Luak', 'Tupai', 'Landak', 'Kupu-kupu',
      'Lebah', 'Capung', 'Tulip', 'Melati', 'Cendana'
    ],
    join: (a, n) => n + ' ' + a
  });
}
