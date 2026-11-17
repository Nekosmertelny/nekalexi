export interface StudyPhoto {
  id: string;
  title: string;
  url: string;
  previewUrl: string;
  license: string;
  sourceUrl: string;
  filename: string;
}

export const CC0_STUDY_PHOTOS: StudyPhoto[] = [
  {
    id: 'desk-notebook',
    title: 'Рабочий стол, блокнот и ручка',
    url: 'https://upload.wikimedia.org/wikipedia/commons/e/ef/Desk-laptop-notebook-pen_%2823958719819%29.jpg',
    previewUrl: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/e/ef/Desk-laptop-notebook-pen_%2823958719819%29.jpg/1280px-Desk-laptop-notebook-pen_%2823958719819%29.jpg',
    license: 'CC0 1.0 (Общественное достояние)',
    sourceUrl: 'https://commons.wikimedia.org/wiki/File:Desk-laptop-notebook-pen_(23958719819).jpg',
    filename: 'desk-notebook-cc0.jpg',
  },
  {
    id: 'oxford-library',
    title: 'Библиотека Оксфордского союза',
    url: 'https://upload.wikimedia.org/wikipedia/commons/8/87/Oxford_Union_Library.jpg',
    previewUrl: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/8/87/Oxford_Union_Library.jpg/1280px-Oxford_Union_Library.jpg',
    license: 'CC0 1.0 (Общественное достояние)',
    sourceUrl: 'https://commons.wikimedia.org/wiki/File:Oxford_Union_Library.jpg',
    filename: 'oxford-union-library-cc0.jpg',
  },
  {
    id: 'library-shelf',
    title: 'Книжные полки библиотеки',
    url: 'https://upload.wikimedia.org/wikipedia/commons/c/c2/Library_bookshelf.jpg',
    previewUrl: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/c/c2/Library_bookshelf.jpg/1280px-Library_bookshelf.jpg',
    license: 'CC0 1.0 (Общественное достояние)',
    sourceUrl: 'https://commons.wikimedia.org/wiki/File:Library_bookshelf.jpg',
    filename: 'library-bookshelf-cc0.jpg',
  },
  {
    id: 'laptop-desk',
    title: 'Минималистичное рабочее место',
    url: 'https://upload.wikimedia.org/wikipedia/commons/6/61/Laptop_on_a_desk.jpg',
    previewUrl: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/6/61/Laptop_on_a_desk.jpg/1280px-Laptop_on_a_desk.jpg',
    license: 'CC0 1.0 (Общественное достояние)',
    sourceUrl: 'https://commons.wikimedia.org/wiki/File:Laptop_on_a_desk.jpg',
    filename: 'laptop-desk-cc0.jpg',
  },
];

export function getPhotoDownloadUrl(photo: StudyPhoto): string {
  return `/api/media/download?url=${encodeURIComponent(photo.url)}&name=${encodeURIComponent(photo.filename)}`;
}
