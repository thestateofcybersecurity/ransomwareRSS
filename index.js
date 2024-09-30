// index.js
const axios = require('axios');
const xml = require('xml');
const xml2js = require('xml2js');
const fs = require('fs').promises; // Use the promise-based version of fs

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
      post_title: item.post_title.replace(/ /g, '_'),
      discovered: new Date(item.discovered).toISOString() // Convert to ISO string for consistency
    }))
    .slice(-20);
}

function generateRSS(data) {
  const items = data.map(item => ({
    item: [
      { title: `${item.group_name}: ${item.post_title}` },
      { pubDate: new Date(item.discovered).toUTCString() },
      { description: `Group: ${item.group_name}, Title: ${item.post_title}, Discovered: ${item.discovered}` }
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

async function updateRSS(newData) {
  let existingFeed;
  try {
    existingFeed = await fs.readFile('feed.xml', 'utf-8');
  } catch (error) {
    console.log('No existing feed found. Creating new feed.');
    return generateRSS(newData);
  }

  const parser = new xml2js.Parser();
  let existingItems;
  try {
    const result = await parser.parseStringPromise(existingFeed);
    existingItems = result.rss.channel[0].item || [];
  } catch (error) {
    console.error('Error parsing existing feed:', error);
    return generateRSS(newData);
  }

  const existingTitles = existingItems.map(item => item.title[0]);

  const updatedItems = newData.filter(item => 
    !existingTitles.includes(`${item.group_name}: ${item.post_title}`)
  );

  const allItems = [
    ...updatedItems.map(item => ({
      title: `${item.group_name}: ${item.post_title}`,
      pubDate: new Date(item.discovered).toUTCString(),
      description: `Group: ${item.group_name}, Title: ${item.post_title}, Discovered: ${item.discovered}`
    })),
    ...existingItems.map(item => ({
      title: item.title[0],
      pubDate: item.pubDate[0],
      description: item.description[0]
    }))
  ];

  // Sort items by pubDate in descending order and limit to 20 items
  allItems.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate)).slice(0, 20);

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
          ...allItems.map(item => ({
            item: [
              { title: item.title },
              { pubDate: item.pubDate },
              { description: item.description }
            ]
          }))
        ]
      }
    ]
  };

  return xml(feed, { declaration: true, indent: '  ' });
}

function generateHTML(data) {
  const rows = data.map(item => `
    <tr>
      <td>${item.group_name}</td>
      <td>${item.post_title}</td>
      <td>${new Date(item.discovered).toLocaleString()}</td>
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
                        const pubDate = new Date(item.querySelector('pubDate').textContent);
                        const row = document.createElement('tr');
                        row.innerHTML = \`
                            <td>\${groupName}</td>
                            <td>\${postTitle}</td>
                            <td>\${pubDate.toLocaleString()}</td>
                        \`;
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
                <th>Discovered</th>
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

async function main() {
  try {
    const data = await fetchData();
    const transformedData = transformData(data);
    const rss = await updateRSS(transformedData);
    const html = generateHTML(transformedData);

    await fs.writeFile('feed.xml', rss);
    await fs.writeFile('index.html', html);

    console.log('Files generated successfully');
  } catch (error) {
    console.error('Error in main function:', error);
  }
}

main().catch(error => console.error('Unhandled error:', error));
