// index.js
const axios = require('axios');
const xml = require('xml');
const fs = require('fs');

async function fetchData() {
  try {
    const response = await axios.get('https://ransomwhat.telemetry.ltd/posts');
    return response.data;
  } catch (error) {
    console.error('Error fetching data:', error);
    return [];
  }
}

function transformData(data) {
  return data
    .map(item => ({
      group_name: item.group_name.replace(/ /g, '_'),
      post_title: item.post_title.replace(/ /g, '_')
    }))
    .slice(-20);
}

function generateRSS(data) {
  const items = data.map(item => ({
    item: [
      { title: `${item.group_name}: ${item.post_title}` },
      { pubDate: new Date().toUTCString() },
      { description: `Group: ${item.group_name}, Title: ${item.post_title}` }
    ]
  }));

  const feed = {
    rss: [
      {
        _attr: {
          version: '2.0',
          'xmlns:atom': 'http://www.w3.org/2005/Atom'
        }
      },
      {
        channel: [
          { title: 'RansomWatch Feed' },
          { description: 'Latest ransomware posts' },
          { link: 'https://yourusername.github.io/ransomwatch/' },
          {
            'atom:link': {
              _attr: {
                href: 'https://yourusername.github.io/ransomwatch/feed.xml',
                rel: 'self',
                type: 'application/rss+xml'
              }
            }
          },
          ...items
        ]
      }
    ]
  };

  return xml(feed, { declaration: true, indent: '  ' });
}

async function main() {
  const data = await fetchData();
  const transformedData = transformData(data);
  const rss = generateRSS(transformedData);

  fs.writeFileSync('feed.xml', rss);
  fs.writeFileSync('index.html', generateHTML(transformedData));

  console.log('Files generated successfully');
}

function generateHTML(data) {
  const rows = data.map(item => `
    <tr>
      <td>${item.group_name}</td>
      <td>${item.post_title}</td>
    </tr>
  `).join('');

  return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>RansomWatch</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 0; padding: 20px; }
        table { border-collapse: collapse; width: 100%; }
        th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
        th { background-color: #f2f2f2; }
    </style>
</head>
<body>
    <h1>RansomWatch</h1>
    <table>
        <tr>
            <th>Group Name</th>
            <th>Post Title</th>
        </tr>
        ${rows}
    </table>
</body>
</html>
  `;
}

main();
