import React from 'react';
import 'bootstrap/dist/css/bootstrap.min.css';

const App: React.FC = () => {
  return (
    <div className='container mt-5'>
      <h1 className='text-primary'>React + Bootstrap + TypeScript Starter</h1>
      <p className='lead'>If you see this, TypeScript and Bootstrap are working!</p>
      <button className='btn btn-success'>Success Button</button>
    </div>
  );
}

export default App;