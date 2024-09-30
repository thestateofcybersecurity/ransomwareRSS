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
          { link: 'https://thestateofcybersecurity.github.io/ransomwareRSS/' },
          {
            'atom:link': {
              _attr: {
                href: 'https://thestateofcybersecurity.github.io/ransomwareRSS/feed.xml',
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
    <script>
        function refreshContent() {
            fetch('feed.xml')
                .then(response => response.text())
                .then(str => new window.DOMParser().parseFromString(str, "text/xml"))
                .then(data => {
                    const items = data.querySelectorAll('item');
                    const tableBody = document.querySelector('tbody');
                    tableBody.innerHTML = '';
                    items.forEach(item => {
                        const title = item.querySelector('title').textContent;
                        const [groupName, postTitle] = title.split(': ');
                        const row = document.createElement('tr');
                        row.innerHTML = \`<td>\${groupName}</td><td>\${postTitle}</td>\`;
                        tableBody.appendChild(row);
                    });
                });
        }

        // Refresh content every 60 seconds
        setInterval(refreshContent, 60000);

        // Initial refresh
        document.addEventListener('DOMContentLoaded', refreshContent);
    </script>
</head>
<body>
    <h1>RansomWatch</h1>
    <table>
        <thead>
            <tr>
                <th>Group Name</th>
                <th>Post Title</th>
            </tr>
        </thead>
        <tbody>
            ${rows}
        </tbody>
    </table>
</body>
</html>
  `;
}

main();
